/**
 * Shared session actions — single source of truth for both the tool and /tmux commands.
 *
 * Every action that mutates or queries tmux state lives here. The tool's execute()
 * and the command's handler() are thin wrappers that format results for their
 * respective interfaces.
 */
import type { AttachLayout } from "./types.js";
import { run, tryRun, isSessionAlive, listWindows, resolveWindow, captureOutput } from "./session.js";
import { attachToSession, closeAttachedSessions, hasAttachedPane } from "./terminal.js";

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface ActionOk {
	ok: true;
	message: string;
	details?: Record<string, unknown>;
}

export interface ActionErr {
	ok: false;
	message: string;
}

export type ActionResult = ActionOk | ActionErr;

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export function actionAttach(
	session: string,
	cwd: string,
	opts: { layout: AttachLayout; window?: number | string; piSessionId?: string | null },
): ActionResult {
	if (!isSessionAlive(session)) return { ok: false, message: `No active session '${session}'.` };

	const targetIdx = opts.window !== undefined ? resolveWindow(session, opts.window) : undefined;

	// Already attached — just focus the window
	if (hasAttachedPane(session)) {
		if (targetIdx !== undefined) {
			tryRun(`tmux select-window -t ${session}:${targetIdx}`);
			return { ok: true, message: `Focused :${targetIdx} (already attached).` };
		}
		return { ok: true, message: "Already attached." };
	}

	const msg = attachToSession(cwd, { mode: opts.layout, tmuxWindow: targetIdx, piSessionId: opts.piSessionId });
	const failed = msg.startsWith("Failed") || msg.startsWith("No");
	return failed ? { ok: false, message: msg } : { ok: true, message: msg };
}

export function actionFocus(session: string, target: number | string): ActionResult {
	if (!isSessionAlive(session)) return { ok: false, message: `No active session '${session}'.` };

	const idx = resolveWindow(session, target);
	if (idx === undefined) return { ok: false, message: `No window '${target}' in session ${session}.` };

	tryRun(`tmux select-window -t ${session}:${idx}`);
	return { ok: true, message: `Switched to :${idx}`, details: { session, window: idx } };
}

export function actionClose(session: string, target: number | string): ActionResult {
	if (!isSessionAlive(session)) return { ok: false, message: `No active session '${session}'.` };

	const idx = resolveWindow(session, target);
	if (idx === undefined) return { ok: false, message: `No window '${target}' in session ${session}.` };

	tryRun(`tmux kill-window -t ${session}:${idx}`);
	const remaining = isSessionAlive(session) ? listWindows(session).length : 0;
	const msg = remaining > 0 ? `Closed :${idx}. ${remaining} window(s) remain.` : `Closed :${idx}. Session ended.`;
	return { ok: true, message: msg, details: { session, window: idx, sessionEnded: remaining === 0 } };
}

export function actionPeek(session: string, target: number | "all"): ActionResult {
	if (!isSessionAlive(session)) return { ok: false, message: `No active session '${session}'.` };

	const output = captureOutput(session, target);
	return { ok: true, message: output, details: { session } };
}

export function actionList(session: string): ActionResult {
	if (!isSessionAlive(session)) return { ok: false, message: `No active session '${session}'.` };

	const windows = listWindows(session);
	const attached = hasAttachedPane(session);
	const formatted = windows.map((w) => `  :${w.index}  ${w.title}${w.active ? "  (active)" : ""}`);
	const header = `Session ${session} — ${windows.length} window(s)${attached ? " (attached)" : ""}`;
	return { ok: true, message: `${header}\n${formatted.join("\n")}`, details: { session, windows, attached } };
}

export function actionKill(session: string): ActionResult {
	if (!isSessionAlive(session)) return { ok: false, message: `No active session '${session}'.` };

	closeAttachedSessions(session);
	run(`tmux kill-session -t ${session}`);
	return { ok: true, message: `Killed session ${session}.` };
}

export function actionClear(session: string): ActionResult {
	if (!isSessionAlive(session)) return { ok: false, message: "No active session." };

	const idleShells = new Set(["bash", "zsh", "sh", "fish", "dash"]);
	const raw = tryRun(`tmux list-windows -t ${session} -F "#{window_index}\t#{pane_current_command}\t#{pane_pid}"`);
	if (!raw) return { ok: false, message: "No windows in session." };

	const idle = raw
		.split("\n")
		.map((line) => {
			const parts = line.split("\t");
			return { index: parseInt(parts[0] ?? "0", 10), cmd: parts[1] ?? "", pid: parts[2] ?? "" };
		})
		.filter((w) => idleShells.has(w.cmd) && !tryRun(`pgrep -P ${w.pid}`));

	if (idle.length === 0) return { ok: true, message: "No idle windows to clear." };

	for (const w of idle) {
		tryRun(`tmux kill-window -t ${session}:${w.index}`);
	}

	const alive = isSessionAlive(session);
	const msg = alive
		? `Cleared ${idle.length} idle window(s).`
		: `Cleared ${idle.length} idle window(s) -- session closed.`;
	return { ok: true, message: msg };
}
