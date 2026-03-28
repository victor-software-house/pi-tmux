/**
 * Shared session actions — single source of truth for both the tool and /tmux commands.
 *
 * Every action that mutates or queries tmux state lives here. The tool's execute()
 * and the command's handler() are thin wrappers that format results for their
 * respective interfaces.
 */
import type { AttachLayout, AutoFocus, WindowReuse } from "./types.js";
import { run, tryRun, isSessionAlive, isWindowIdle, listWindows, resolveWindow, captureOutput, deriveWindowName, tmuxEscape } from "./session.js";
import { attachToSession, closeAttachedSessions, hasAttachedPane } from "./terminal.js";
import { sendCommand, createWindowWithCommand, startCommandInFirstWindow, clearSilenceForWindow } from "./signals.js";

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
// run
// ---------------------------------------------------------------------------

export interface RunOpts {
	command: string;
	name?: string;
	cwd: string;
	windowReuse: WindowReuse;
	maxWindows: number;
	autoFocus: AutoFocus;
}

export function actionRun(session: string, opts: RunOpts): ActionResult {
	const windowName = opts.name ? opts.name.slice(0, 30) : deriveWindowName(opts.command);
	const alive = isSessionAlive(session);

	let windowIndex: number;
	let reused = false;

	if (!alive) {
		run(`tmux new-session -d -s ${session} -c "${opts.cwd}"`);
		startCommandInFirstWindow(session, windowName, opts.command);
		windowIndex = 0;
	} else {
		const windows = listWindows(session);

		let reuseCandidate: (typeof windows)[number] | undefined;
		if (opts.windowReuse !== "never") {
			if (opts.name) {
				reuseCandidate = windows
					.filter((w) => w.title === opts.name && isWindowIdle(session, w.index))
					.at(-1);
			} else if (opts.windowReuse === "last") {
				reuseCandidate = [...windows].reverse().find((w) => isWindowIdle(session, w.index));
			}
		}

		if (reuseCandidate) {
			const idx = reuseCandidate.index;
			tryRun(`tmux rename-window -t ${session}:${idx} "${tmuxEscape(windowName)}"`);
			sendCommand(session, idx, opts.command);
			windowIndex = idx;
			reused = true;
		} else {
			if (windows.length >= opts.maxWindows) {
				return {
					ok: false,
					message: `Error: ${windows.length} windows open (max: ${opts.maxWindows}). Close idle windows first.`,
				};
			}
			windowIndex = createWindowWithCommand(session, opts.cwd, opts.command, windowName);
		}
	}

	if (opts.autoFocus === "always" && isSessionAlive(session)) {
		tryRun(`tmux select-window -t ${session}:${windowIndex}`);
	}

	const verb = !alive ? "Created" : reused ? "Reused" : "Added to";
	return {
		ok: true,
		message: `${verb} session ${session}\n  :${windowIndex}  ${windowName}: ${opts.command}`,
		details: { session, windowIndex, windowName, created: !alive, reused },
	};
}

// ---------------------------------------------------------------------------
// attach — open terminal pane, or acknowledge if already attached
// ---------------------------------------------------------------------------

export function actionAttach(
	session: string,
	cwd: string,
	opts: { layout: AttachLayout; window?: number | string; piSessionId?: string | null },
): ActionResult {
	if (!isSessionAlive(session)) return { ok: false, message: `No active session '${session}'.` };

	const targetIdx = opts.window !== undefined ? resolveWindow(session, opts.window) : undefined;

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

// ---------------------------------------------------------------------------
// focus — switch tmux window
// ---------------------------------------------------------------------------

export function actionFocus(session: string, target: number | string): ActionResult {
	if (!isSessionAlive(session)) return { ok: false, message: `No active session '${session}'.` };

	const idx = resolveWindow(session, target);
	if (idx === undefined) return { ok: false, message: `No window '${target}' in session ${session}.` };

	tryRun(`tmux select-window -t ${session}:${idx}`);
	return { ok: true, message: `Switched to :${idx}`, details: { session, window: idx } };
}

// ---------------------------------------------------------------------------
// close — kill a single window
// ---------------------------------------------------------------------------

export function actionClose(session: string, target: number | string): ActionResult {
	if (!isSessionAlive(session)) return { ok: false, message: `No active session '${session}'.` };

	const idx = resolveWindow(session, target);
	if (idx === undefined) return { ok: false, message: `No window '${target}' in session ${session}.` };

	tryRun(`tmux kill-window -t ${session}:${idx}`);
	const remaining = isSessionAlive(session) ? listWindows(session).length : 0;
	const msg = remaining > 0 ? `Closed :${idx}. ${remaining} window(s) remain.` : `Closed :${idx}. Session ended.`;
	return { ok: true, message: msg, details: { session, window: idx, sessionEnded: remaining === 0 } };
}

// ---------------------------------------------------------------------------
// peek — capture recent output
// ---------------------------------------------------------------------------

export function actionPeek(session: string, target: number | "all"): ActionResult {
	if (!isSessionAlive(session)) return { ok: false, message: `No active session '${session}'.` };

	const output = captureOutput(session, target);
	return { ok: true, message: output, details: { session } };
}

// ---------------------------------------------------------------------------
// list — show windows and status
// ---------------------------------------------------------------------------

export function actionList(session: string): ActionResult {
	if (!isSessionAlive(session)) return { ok: false, message: `No active session '${session}'.` };

	const windows = listWindows(session);
	const attached = hasAttachedPane(session);
	const formatted = windows.map((w) => `  :${w.index}  ${w.title}${w.active ? "  (active)" : ""}`);
	const header = `Session ${session} — ${windows.length} window(s)${attached ? " (attached)" : ""}`;
	return { ok: true, message: `${header}\n${formatted.join("\n")}`, details: { session, windows, attached } };
}

// ---------------------------------------------------------------------------
// kill — terminate session
// ---------------------------------------------------------------------------

export function actionKill(session: string): ActionResult {
	if (!isSessionAlive(session)) return { ok: false, message: `No active session '${session}'.` };

	closeAttachedSessions(session);
	run(`tmux kill-session -t ${session}`);
	return { ok: true, message: `Killed session ${session}.` };
}

// ---------------------------------------------------------------------------
// clear — kill idle windows
// ---------------------------------------------------------------------------

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
		: `Cleared ${idle.length} idle window(s) — session closed.`;
	return { ok: true, message: msg };
}

// ---------------------------------------------------------------------------
// mute — disable silence notifications for a window
// ---------------------------------------------------------------------------

export function actionMute(session: string, windowIndex: number): ActionResult {
	if (!isSessionAlive(session)) return { ok: false, message: `No active session '${session}'.` };

	clearSilenceForWindow(session, windowIndex);
	const windows = listWindows(session);
	const w = windows.find((win) => win.index === windowIndex);
	return { ok: true, message: `Muted silence alerts for "${w?.title ?? `window ${windowIndex}`}" (:${windowIndex}).` };
}
