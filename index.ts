import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
	agentName,
	agentStartArgs,
	CONFIG_FILE,
	CURRENT_LABEL,
	currentForkLeaf,
	createArgs,
	createdPaneId,
	DRAFT_ENV,
	FORK_TARGETS,
	type ForkPoint,
	type ForkTarget,
	forkPoints,
	herdrErrorText,
	isStaleDraft,
	parseDraft,
	parseShortcutSetting,
	parseTarget,
	type ShortcutSetting,
	pointLabel,
	preview,
	shellIsIdle,
} from "./fork";

const TARGET_LABELS: Record<ForkTarget, string> = {
	right: "New pane to the right",
	down: "New pane below",
	tab: "New tab",
};
// Agent start waits for Pi to be ready; allow for a slow first launch.
const AGENT_START_TIMEOUT_MS = 60_000;
// Fresh shells can run startup work (update checks, plugin managers) first.
const SHELL_READY_TIMEOUT_MS = 15_000;

type ShortcutKey = Parameters<ExtensionAPI["registerShortcut"]>[0];

/** `~/.pi/agent/extensions/pi-herdr-fork.json`, next to the extensions it configures. */
function readShortcutSetting(): ShortcutSetting {
	const file = join(getAgentDir(), "extensions", CONFIG_FILE);
	if (!existsSync(file)) return parseShortcutSetting(undefined);
	try {
		return parseShortcutSetting(readFileSync(file, "utf8"));
	} catch {
		return parseShortcutSetting("");
	}
}

/** Private per-user folder for draft hand-off files. */
function draftDir(): string {
	const uid = process.getuid?.();
	const dir = join(tmpdir(), uid === undefined ? "pi-herdr-fork" : `pi-herdr-fork-${uid}`);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

/** Remove drafts left by panes that never started Pi. Best effort. */
function pruneStaleDrafts(dir: string, now = Date.now()): void {
	try {
		for (const name of readdirSync(dir)) {
			const file = join(dir, name);
			try {
				if (isStaleDraft(name, statSync(file).mtimeMs, now)) unlinkSync(file);
			} catch {
				// raced with another Pi consuming it
			}
		}
	} catch {
		// folder unreadable; nothing to prune
	}
}

/** Write a fork of the active session ending at `point.parentId`, without switching sessions. */
function writeFork(ctx: ExtensionContext, point: ForkPoint): string | undefined {
	if (point.parentId === null) return undefined; // first message: start fresh
	const source = ctx.sessionManager.getSessionFile();
	if (!source) throw new Error("this session is not saved to disk, so it cannot be forked");
	// A separate manager keeps the current session's leaf and file untouched.
	const fork = SessionManager.open(source, ctx.sessionManager.getSessionDir());
	const file = fork.createBranchedSession(point.parentId);
	if (!file) throw new Error("Pi did not write the forked session");
	return file;
}

async function chooseTarget(
	ctx: ExtensionContext,
	requested: ForkTarget | undefined,
): Promise<ForkTarget | undefined> {
	if (requested) return requested;
	const label = await ctx.ui.select(
		"Open the fork in",
		FORK_TARGETS.map((target) => TARGET_LABELS[target]),
	);
	return FORK_TARGETS.find((target) => TARGET_LABELS[target] === label);
}

export default function herdrFork(pi: ExtensionAPI) {
	const shortcut = readShortcutSetting();

	/** Shared by `/herdr-fork` and the keyboard shortcut. */
	async function runFork(ctx: ExtensionContext, args: string): Promise<void> {
		const fail = (message: string) => ctx.ui.notify(`herdr-fork: ${message}`, "error");
		if (!process.env.HERDR_PANE_ID) return fail("run Pi inside a Herdr pane to use this command");
		const requested = parseTarget(args);
		if (args.trim() && !requested) return fail(`unknown target "${args.trim()}"; use right, down, or tab`);

		const branch = ctx.sessionManager.getBranch();
		const points = forkPoints(branch);
		if (points.length === 0) return fail("there are no messages to fork from yet");
		// "Current state" copies everything so far (like /clone) and opens an empty editor.
		const leaf = currentForkLeaf(branch);
		const current: ForkPoint | undefined = leaf ? { parentId: leaf, text: "", index: 0 } : undefined;
		const labels = [...(current ? [CURRENT_LABEL] : []), ...points.map(pointLabel).reverse()]; // newest first
		const picked = await ctx.ui.select("Fork from which message?", labels);
		const point = picked === CURRENT_LABEL ? current : points.find((candidate) => pointLabel(candidate) === picked);
		if (!point) return;
		const what = point.index === 0 ? "the current state" : `message #${point.index}`;
		const target = await chooseTarget(ctx, requested);
		if (!target) return;

		let sessionFile: string | undefined;
		try {
			sessionFile = writeFork(ctx, point);
		} catch (error) {
			return fail(error instanceof Error ? error.message : String(error));
		}

		const dir = draftDir();
		pruneStaleDrafts(dir);
		const id = randomUUID();
		const draftFile = join(dir, `${id}.json`);
		writeFileSync(draftFile, JSON.stringify({ sessionFile, text: point.text }), { mode: 0o600 });
		const discardDraft = () => {
			try { unlinkSync(draftFile); } catch { /* already consumed */ }
		};
		const herdr = process.env.HERDR_BIN_PATH || "herdr";
		const place = target === "tab" ? "tab" : "pane";

		const created = await pi.exec(
			herdr,
			createArgs(target, {
				cwd: ctx.cwd,
				label: `fork: ${point.text ? preview(point.text, 24) : "current"}`,
				draftFile,
				focus: true,
			}),
			{ cwd: ctx.cwd, timeout: 10_000 },
		);
		const paneId = created.code === 0 ? createdPaneId(created.stdout) : undefined;
		if (!paneId) {
			discardDraft();
			return fail(`Herdr could not open a ${place}: ${herdrErrorText(created.stdout, created.stderr)}`);
		}

		// Let the new shell finish its startup work; agent start rejects a busy shell.
		// Two idle checks in a row: startup scripts can pause between steps
		// (e.g. Oh My Zsh's update check, then the update itself).
		const deadline = Date.now() + SHELL_READY_TIMEOUT_MS;
		let idleChecks = 0;
		while (idleChecks < 2 && Date.now() < deadline) {
			const info = await pi.exec(herdr, ["pane", "process-info", "--pane", paneId], { timeout: 5_000 });
			idleChecks = info.code === 0 && shellIsIdle(info.stdout) ? idleChecks + 1 : 0;
			if (idleChecks < 2) await new Promise((resolve) => setTimeout(resolve, 150));
		}

		const started = await pi.exec(herdr, agentStartArgs(agentName(point.index, id), paneId, sessionFile), {
			cwd: ctx.cwd,
			timeout: AGENT_START_TIMEOUT_MS + 5_000,
		});
		if (started.code !== 0) {
			discardDraft();
			await pi.exec(herdr, ["pane", "close", paneId], { timeout: 5_000 }).catch(() => undefined);
			return fail(`Herdr could not start Pi in the new ${place}: ${herdrErrorText(started.stdout, started.stderr)}`);
		}
		ctx.ui.notify(`Forked ${what} into a new ${place}`, "info");
	}

	pi.on("session_start", (event, ctx) => {
		if (event.reason !== "startup") return;
		if (shortcut.warning && ctx.hasUI) ctx.ui.notify(`herdr-fork: ${shortcut.warning}`, "warning");

		// The new pane's Pi restores the chosen message into its editor, once, at startup.
		const draftFile = process.env[DRAFT_ENV];
		if (!draftFile) return;
		delete process.env[DRAFT_ENV];
		let raw: string;
		try {
			raw = readFileSync(draftFile, "utf8");
			unlinkSync(draftFile);
		} catch {
			return; // already consumed, e.g. a later `pi` in the same shell
		}
		const draft = parseDraft(raw);
		if (!draft?.text || !ctx.hasUI) return; // current-state forks start with an empty editor
		if (draft.sessionFile && draft.sessionFile !== ctx.sessionManager.getSessionFile()) return;
		ctx.ui.setEditorText(draft.text);
	});

	pi.registerCommand("herdr-fork", {
		description: "Fork the session from a chosen message into a new Herdr pane or tab",
		getArgumentCompletions: (prefix) =>
			FORK_TARGETS.filter((value) => value.startsWith(prefix.trim().toLowerCase())).map((value) => ({
				value,
				label: value,
			})),
		handler: (args, ctx) => runFork(ctx, args),
	});

	if (shortcut.shortcut) {
		// SAFETY: parseShortcutSetting only returns strings that pass isShortcut (Pi's KeyId grammar).
		pi.registerShortcut(shortcut.shortcut as ShortcutKey, {
			description: "Fork the session from a chosen message into a new Herdr pane or tab",
			handler: (ctx) => runFork(ctx, ""),
		});
	}
}
