import { describe, expect, test } from "bun:test";
import {
	agentName,
	agentStartArgs,
	createArgs,
	currentForkLeaf,
	DEFAULT_SHORTCUT,
	DRAFT_TTL_MS,
	herdrErrorText,
	isShortcut,
	isStaleDraft,
	parseShortcutSetting,
	createdPaneId,
	DRAFT_ENV,
	forkPoints,
	messageText,
	parseDraft,
	parseTarget,
	pointLabel,
	preview,
	shellIsIdle,
} from "./fork";

const user = (id: string, parentId: string | null, content: unknown) => ({
	type: "message", id, parentId, message: { role: "user", content },
});
const assistant = (id: string, parentId: string) => ({
	type: "message", id, parentId, message: { role: "assistant", content: "ok" },
});

describe("fork points", () => {
	test("lists user messages on the branch with the entry to fork from", () => {
		const branch = [
			{ type: "session_info", id: "i", parentId: null },
			user("u1", "i", "first question"),
			assistant("a1", "u1"),
			user("u2", "a1", [{ type: "text", text: "second" }, { type: "image" }, { type: "text", text: "line" }]),
			assistant("a2", "u2"),
		];
		expect(forkPoints(branch)).toEqual([
			{ parentId: "i", text: "first question", index: 1 },
			{ parentId: "a1", text: "second\nline", index: 2 },
		]);
	});

	test("forks the very first message into an empty session and skips blank prompts", () => {
		expect(forkPoints([user("u1", null, "hello"), user("u2", "u1", "   "), user("u3", "u1", [{ type: "image" }])]))
			.toEqual([{ parentId: null, text: "hello", index: 1 }]);
	});

	test("labels are numbered single-line previews", () => {
		expect(pointLabel({ parentId: "p", text: "a\n\n  b", index: 3 })).toBe("#3  a b");
		expect(preview("x".repeat(100), 10)).toBe(`${"x".repeat(9)}…`);
		expect(messageText(undefined)).toBe("");
	});
});

describe("current state", () => {
	const toolCall = (id: string, parentId: string, ...callIds: string[]) => ({
		type: "message", id, parentId,
		message: { role: "assistant", content: callIds.map((callId) => ({ type: "toolCall", id: callId, name: "bash" })) },
	});
	const result = (id: string, parentId: string, callId: string) => ({
		type: "message", id, parentId, message: { role: "toolResult", toolCallId: callId, content: "ok" },
	});

	test("ends at the newest entry when the conversation is settled", () => {
		expect(currentForkLeaf([user("u1", null, "hi"), assistant("a1", "u1")])).toBe("a1");
		expect(currentForkLeaf([
			user("u1", null, "hi"), toolCall("a1", "u1", "c1", "c2"), result("r1", "a1", "c1"), result("r2", "r1", "c2"),
		])).toBe("r2");
	});

	test("mid-response, stops before tool calls that are still waiting for results", () => {
		const branch = [
			user("u1", null, "hi"), toolCall("a1", "u1", "c1"), result("r1", "a1", "c1"),
			toolCall("a2", "r1", "c2", "c3"), result("r2", "a2", "c2"),
		];
		expect(currentForkLeaf(branch)).toBe("r1");
	});

	test("returns nothing for an empty branch", () => {
		expect(currentForkLeaf([])).toBeUndefined();
	});
});

describe("shortcut setting", () => {
	test("defaults to ctrl+alt+f when there is no config or no shortcut key", () => {
		expect(DEFAULT_SHORTCUT).toBe("ctrl+alt+f");
		expect(parseShortcutSetting(undefined)).toEqual({ shortcut: "ctrl+alt+f" });
		expect(parseShortcutSetting("{}")).toEqual({ shortcut: "ctrl+alt+f" });
	});

	test("accepts a custom key, normalizing case and spacing", () => {
		expect(parseShortcutSetting(JSON.stringify({ shortcut: " Ctrl+Shift+K " }))).toEqual({ shortcut: "ctrl+shift+k" });
		expect(parseShortcutSetting(JSON.stringify({ shortcut: "f9" }))).toEqual({ shortcut: "f9" });
	});

	test("false or an empty string turns the shortcut off", () => {
		expect(parseShortcutSetting(JSON.stringify({ shortcut: false }))).toEqual({ shortcut: undefined });
		expect(parseShortcutSetting(JSON.stringify({ shortcut: "" }))).toEqual({ shortcut: undefined });
	});

	test("bad config falls back to the default with a warning instead of failing", () => {
		for (const raw of ["not json", "[]", JSON.stringify({ shortcut: "ctrl+banana" }), JSON.stringify({ shortcut: 5 })]) {
			const setting = parseShortcutSetting(raw);
			expect(setting.shortcut).toBe(DEFAULT_SHORTCUT);
			expect(setting.warning).toContain("pi-herdr-fork.json");
		}
	});

	test("validates Pi key ids", () => {
		for (const ok of ["ctrl+alt+f", "alt+shift+up", "f12", "ctrl+]"]) expect(isShortcut(ok)).toBe(true);
		for (const bad of ["", "ctrl+", "ctrl+ctrl+f", "hyper+f", "ctrl+alt+ff"]) expect(isShortcut(bad)).toBe(false);
	});
});

describe("targets and commands", () => {
	test("parses targets with pane as an alias for right", () => {
		expect(parseTarget("TAB")).toBe("tab");
		expect(parseTarget(" pane ")).toBe("right");
		expect(parseTarget("down")).toBe("down");
		expect(parseTarget("")).toBeUndefined();
		expect(parseTarget("left")).toBeUndefined();
	});

	test("starts Pi as a Herdr agent, passing the session path as a raw argument", () => {
		expect(agentStartArgs("fork-2-abc", "w1:p2", "/a b/it's.jsonl")).toEqual([
			"agent", "start", "fork-2-abc", "--kind", "pi", "--pane", "w1:p2", "--", "--session", "/a b/it's.jsonl",
		]);
		expect(agentStartArgs("fork-1-abc", "w1:p2", undefined)).toEqual([
			"agent", "start", "fork-1-abc", "--kind", "pi", "--pane", "w1:p2",
		]);
		expect(agentName(3, "A1-b2c3d4e5")).toBe("fork-3-a1b2c3");
	});

	test("treats the pane as ready only when the shell alone is in the foreground", () => {
		const info = (pids: number[]) => JSON.stringify({
			result: { process_info: { shell_pid: 10, foreground_processes: pids.map((pid) => ({ pid })) } },
		});
		expect(shellIsIdle(info([10]))).toBe(true);
		expect(shellIsIdle(info([11, 10]))).toBe(false); // e.g. Oh My Zsh's update-check curl
		expect(shellIsIdle(info([]))).toBe(false);
		expect(shellIsIdle("{}")).toBe(false);
		expect(shellIsIdle("not json")).toBe(false);
	});

	test("extracts readable Herdr errors from JSON or raw output", () => {
		expect(herdrErrorText("", JSON.stringify({ id: "x", error: { code: "busy", message: "pane is not at a prompt" } })))
			.toBe("pane is not at a prompt");
		expect(herdrErrorText("", "socket missing\n")).toBe("socket missing");
		expect(herdrErrorText("out", "")).toBe("out");
		expect(herdrErrorText("", "")).toBe("no output");
	});

	test("treats only day-old draft files as stale", () => {
		const now = 10 * DRAFT_TTL_MS;
		expect(isStaleDraft("a.json", now - DRAFT_TTL_MS - 1, now)).toBe(true);
		expect(isStaleDraft("a.json", now - 1000, now)).toBe(false);
		expect(isStaleDraft("notes.txt", 0, now)).toBe(false);
	});

	test("builds Herdr split and tab arguments that pass the draft through the environment", () => {
		const options = { cwd: "/proj", label: "fork: x", draftFile: "/tmp/d.json", focus: true };
		expect(createArgs("down", options)).toEqual([
			"pane", "split", "--current", "--direction", "down",
			"--cwd", "/proj", "--env", `${DRAFT_ENV}=/tmp/d.json`, "--focus",
		]);
		expect(createArgs("tab", { ...options, focus: false })).toEqual([
			"tab", "create", "--label", "fork: x",
			"--cwd", "/proj", "--env", `${DRAFT_ENV}=/tmp/d.json`, "--no-focus",
		]);
	});

	test("reads the new pane id from split and tab responses", () => {
		expect(createdPaneId(JSON.stringify({ result: { pane: { pane_id: "w1:p2" } } }))).toBe("w1:p2");
		expect(createdPaneId(JSON.stringify({ result: { tab: {}, root_pane: { pane_id: "w1:p3" } } }))).toBe("w1:p3");
		expect(createdPaneId("not json")).toBeUndefined();
		expect(createdPaneId("{}")).toBeUndefined();
	});

	test("validates draft payloads", () => {
		expect(parseDraft(JSON.stringify({ sessionFile: "/s.jsonl", text: "hi" }))).toEqual({ sessionFile: "/s.jsonl", text: "hi" });
		expect(parseDraft(JSON.stringify({ text: "hi" }))).toEqual({ sessionFile: undefined, text: "hi" });
		expect(parseDraft("{}")).toBeUndefined();
		expect(parseDraft("nope")).toBeUndefined();
	});
});
