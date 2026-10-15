/** Pure helpers: message selection, Herdr argument building, and draft handoff. */

export type ForkTarget = "right" | "down" | "tab";
export const FORK_TARGETS: readonly ForkTarget[] = ["right", "down", "tab"];
export const DRAFT_ENV = "PI_HERDR_FORK_DRAFT";

export interface ForkPoint {
	/** Entry the fork continues from; null forks into an empty session. */
	parentId: string | null;
	/** The selected user message, restored into the new pane's editor. */
	text: string;
	/** 1-based position among the branch's user messages. */
	index: number;
}

interface BranchEntry {
	id?: unknown;
	parentId?: unknown;
	type?: unknown;
	message?: { role?: unknown; content?: unknown };
}

export function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block: { type?: unknown; text?: unknown }) =>
			block?.type === "text" && typeof block.text === "string" ? block.text : "",
		)
		.filter(Boolean)
		.join("\n");
}

/** User messages on the active branch, oldest first. */
export function forkPoints(branch: readonly unknown[]): ForkPoint[] {
	const points: ForkPoint[] = [];
	for (const raw of branch) {
		const entry = raw as BranchEntry;
		if (entry?.type !== "message" || entry.message?.role !== "user") continue;
		const text = messageText(entry.message.content).trim();
		if (!text) continue;
		points.push({
			parentId: typeof entry.parentId === "string" ? entry.parentId : null,
			text,
			index: points.length + 1,
		});
	}
	return points;
}

/**
 * Latest entry the whole conversation can be forked at. Mid-response, the newest
 * entries can be tool calls still waiting for results; a fork ending there would
 * be invalid, so stop at the last point where every tool call has its result.
 */
export function currentForkLeaf(branch: readonly unknown[]): string | undefined {
	const pending = new Set<string>();
	let leaf: string | undefined;
	for (const raw of branch) {
		const entry = raw as BranchEntry & { message?: { toolCallId?: unknown } };
		const message = entry?.message;
		if (entry?.type === "message" && message?.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content as { type?: unknown; id?: unknown }[])
				if (block?.type === "toolCall" && typeof block.id === "string") pending.add(block.id);
		}
		if (entry?.type === "message" && message?.role === "toolResult" && typeof message.toolCallId === "string")
			pending.delete(message.toolCallId);
		if (pending.size === 0 && typeof entry?.id === "string") leaf = entry.id;
	}
	return leaf;
}

export const CURRENT_LABEL = "● Current state (whole conversation so far)";

export function preview(text: string, max = 72): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length <= max ? line : `${line.slice(0, max - 1)}\u2026`;
}

export function pointLabel(point: ForkPoint): string {
	return `#${point.index}  ${preview(point.text)}`;
}

export function parseTarget(value: string | undefined): ForkTarget | undefined {
	const normalized = value?.trim().toLowerCase();
	if (!normalized) return undefined;
	if (normalized === "pane") return "right";
	return (FORK_TARGETS as readonly string[]).includes(normalized)
		? (normalized as ForkTarget)
		: undefined;
}

/**
 * Adopt Pi into the new pane. Herdr runs its canonical Pi executable, waits for
 * readiness, and tracks the pane as a Pi agent; arguments bypass the shell.
 */
export function agentStartArgs(name: string, paneId: string, sessionFile: string | undefined): string[] {
	return [
		"agent", "start", name, "--kind", "pi", "--pane", paneId,
		...(sessionFile ? ["--", "--session", sessionFile] : []),
	];
}

/** Unique, Herdr-safe agent name such as `fork-3-a1b2c3`. */
export function agentName(index: number, suffix: string): string {
	return `fork-${index}-${suffix.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6)}`;
}

/**
 * `herdr agent start` needs the shell itself in the foreground. Fresh shells can
 * briefly run startup work first (e.g. Oh My Zsh's update check runs `curl`).
 * True when `pane process-info` shows only the shell in the foreground.
 */
export function shellIsIdle(stdout: string): boolean {
	try {
		const info = JSON.parse(stdout)?.result?.process_info;
		const foreground = info?.foreground_processes;
		if (!Array.isArray(foreground) || typeof info?.shell_pid !== "number") return false;
		return foreground.length > 0 && foreground.every((process: { pid?: unknown }) => process?.pid === info.shell_pid);
	} catch {
		return false;
	}
}

/** Herdr prints failures as `{"error":{"message":...}}`; surface the readable part. */
export function herdrErrorText(stdout: string, stderr: string): string {
	const raw = stderr.trim() || stdout.trim() || "no output";
	try {
		const message = JSON.parse(raw)?.error?.message;
		if (typeof message === "string" && message) return message.slice(0, 300);
	} catch {
		// not JSON; use the raw text
	}
	return raw.slice(0, 300);
}

/**
 * Not a Pi built-in, not bound by Herdr (whose direct key is only its prefix),
 * and unused by common extensions. "f" for fork.
 */
export const DEFAULT_SHORTCUT = "ctrl+alt+f";
export const CONFIG_FILE = "pi-herdr-fork.json";

const SHORTCUT_MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);
const SHORTCUT_KEYS = new Set([
	..."abcdefghijklmnopqrstuvwxyz0123456789",
	"escape", "esc", "enter", "return", "tab", "space", "backspace", "delete", "insert",
	"home", "end", "pageup", "pagedown", "up", "down", "left", "right",
	...Array.from({ length: 12 }, (_, index) => `f${index + 1}`),
	..."`-=[]\\;',./",
]);

/** A Pi key id such as `ctrl+alt+f`: known modifiers, no repeats, one key. */
export function isShortcut(value: string): boolean {
	const parts = value.toLowerCase().split("+");
	const key = parts.pop();
	if (!key || !SHORTCUT_KEYS.has(key)) return false;
	return new Set(parts).size === parts.length && parts.every((part) => SHORTCUT_MODIFIERS.has(part));
}

export interface ShortcutSetting {
	/** Key to register, or undefined when the user turned the shortcut off. */
	shortcut: string | undefined;
	/** Shown once at startup when the config could not be used. */
	warning?: string;
}

/**
 * `{"shortcut": "ctrl+alt+f"}` sets the key; `false` or `""` turns it off.
 * Bad config never blocks loading: it falls back to the default with a warning.
 */
export function parseShortcutSetting(raw: string | undefined): ShortcutSetting {
	if (raw === undefined) return { shortcut: DEFAULT_SHORTCUT };
	const fallback = (problem: string): ShortcutSetting => ({
		shortcut: DEFAULT_SHORTCUT,
		warning: `${CONFIG_FILE}: ${problem}; using ${DEFAULT_SHORTCUT}`,
	});
	let config: unknown;
	try {
		config = JSON.parse(raw);
	} catch {
		return fallback("not valid JSON");
	}
	if (!config || typeof config !== "object" || Array.isArray(config)) return fallback("expected a JSON object");
	const value = (config as { shortcut?: unknown }).shortcut;
	if (value === undefined) return { shortcut: DEFAULT_SHORTCUT };
	if (value === false || value === "") return { shortcut: undefined };
	if (typeof value !== "string" || !isShortcut(value.trim()))
		return fallback(`"${String(value)}" is not a valid key, e.g. "ctrl+alt+f"`);
	return { shortcut: value.trim().toLowerCase() };
}

export const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

/** Draft files left behind by panes that never started Pi. */
export function isStaleDraft(name: string, modifiedMs: number, now: number): boolean {
	return name.endsWith(".json") && now - modifiedMs > DRAFT_TTL_MS;
}

export function createArgs(
	target: ForkTarget,
	options: { cwd: string; label: string; draftFile: string; focus: boolean },
): string[] {
	const common = [
		"--cwd",
		options.cwd,
		"--env",
		`${DRAFT_ENV}=${options.draftFile}`,
		options.focus ? "--focus" : "--no-focus",
	];
	return target === "tab"
		? ["tab", "create", "--label", options.label, ...common]
		: ["pane", "split", "--current", "--direction", target, ...common];
}

/** Herdr replies `{ result: { pane } }` for splits and `{ result: { root_pane } }` for tabs. */
export function createdPaneId(stdout: string): string | undefined {
	try {
		const result = JSON.parse(stdout)?.result;
		const pane = result?.pane ?? result?.root_pane;
		return typeof pane?.pane_id === "string" ? pane.pane_id : undefined;
	} catch {
		return undefined;
	}
}

export interface Draft {
	/** Session the draft belongs to; undefined matches a fresh session. */
	sessionFile?: string;
	text: string;
}

export function parseDraft(raw: string): Draft | undefined {
	try {
		const value = JSON.parse(raw) as Partial<Draft>;
		if (typeof value?.text !== "string") return undefined;
		return {
			text: value.text,
			sessionFile: typeof value.sessionFile === "string" ? value.sessionFile : undefined,
		};
	} catch {
		return undefined;
	}
}
