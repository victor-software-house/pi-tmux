/**
 * Shared session actions — single source of truth for both the tool and /tmux commands.
 *
 * Every action that mutates or queries tmux state lives here. The tool's execute()
 * and the command's handler() are thin wrappers that format results for their
 * respective interfaces.
 */
import type { AttachLayout, AutoFocus, WindowReuse } from "./types.js";
import { run, tryRun, isSessionAlive, isWindowIdle, listWindows, resolveWindow, captureOutput, deriveWindowName, tmuxEscape, getPiWindowIndex, ensureStagingSession, ensureViewPane, createStagingWindow, swapViewPane, respawnStagingWindow, deriveStagingName } from "./session.js";
import { attachToSession, closeAttachedSessions, hasAttachedPane } from "./terminal.js";
import { sendCommand, createWindowWithCommand, startCommandInFirstWindow, clearSilenceForWindow, trackCompletionByPane } from "./signals.js";

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
	defaultLayout: string;
}

export function actionRun(session: string, opts: RunOpts): ActionResult {
	const windowName = opts.name ? opts.name.slice(0, 30) : deriveWindowName(opts.command);

	// -------------------------------------------------------------------
	// Tmux mode: staging session + view pane swap (zero flash)
	// -------------------------------------------------------------------
	if (process.env.TMUX) {
		const staging = ensureStagingSession(session, opts.cwd);
		ensureViewPane(session, opts.cwd, opts.defaultLayout);

		const stagingWindows = listWindows(session); // uses staging via listWindows

		// Try to reuse an idle staging window
		let stagingIdx: number | undefined;
		let reused = false;

		if (opts.windowReuse !== "never") {
			let candidate: typeof stagingWindows[number] | undefined;
			if (opts.name) {
				candidate = stagingWindows.filter((w) => w.title === opts.name && isWindowIdle(staging, w.index)).at(-1);
			} else if (opts.windowReuse === "last") {
				candidate = [...stagingWindows].reverse().find((w) => isWindowIdle(staging, w.index));
			}
			if (candidate) {
				stagingIdx = candidate.index;
				respawnStagingWindow(staging, stagingIdx, opts.cwd);
				tryRun(`tmux rename-window -t ${staging}:${stagingIdx} "${tmuxEscape(windowName)}"`);
				reused = true;
			}
		}

		if (stagingIdx === undefined) {
			if (stagingWindows.length >= opts.maxWindows) {
				return { ok: false, message: `Error: ${stagingWindows.length} windows open (max: ${opts.maxWindows}). Close idle windows first.` };
			}
			stagingIdx = createStagingWindow(staging, opts.cwd, windowName);
		}

		// Send command to staging window before swap
		sendCommand(staging, stagingIdx, opts.command);

		// Swap into view pane (atomic, no flash)
		swapViewPane(session, staging, stagingIdx);

		// Get the pane ID now in the view (for completion tracking)
		const paneId = tryRun(`tmux list-panes -t ${session}:0 -F "#{pane_index} #{pane_id}"`)
			?.split("\n").find((l) => l.startsWith("1 "))?.split(" ")[1] ?? "";

		return {
			ok: true,
			message: `${reused ? "Reused" : "Added"} staging window ${stagingIdx} — ${windowName}`,
			details: { session, stagingIdx, paneId, windowName, created: false, reused },
		};
	}

	// -------------------------------------------------------------------
	// Legacy mode: window-per-command
	// -------------------------------------------------------------------
	const alive = isSessionAlive(session);
	let windowIndex: number;
	let reused = false;

	if (!alive) {
		run(`tmux new-session -d -s ${session} -c "${opts.cwd}"`);
		tryRun(`tmux source-file ~/.config/pi-tmux/tmux.conf`);
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

	// In tmux CC mode, select-window switches the iTerm tab away from pi.
	// Focus is handled by the user clicking the tab or via /tmux focus.
	if (opts.autoFocus === "always" && isSessionAlive(session) && !process.env.TMUX) {
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
	opts: { layout: AttachLayout; window?: number | string },
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

	const msg = attachToSession(cwd, { mode: opts.layout, tmuxWindow: targetIdx });
	const failed = msg.startsWith("Failed") || msg.startsWith("No");
	return failed ? { ok: false, message: msg } : { ok: true, message: msg };
}

// ---------------------------------------------------------------------------
// focus — switch tmux window
// ---------------------------------------------------------------------------

export function actionFocus(session: string, target: number | string): ActionResult {
	if (!isSessionAlive(session)) return { ok: false, message: `No active session '${session}'.` };

	if (process.env.TMUX) {
		// Focus = swap the requested staging window into the view pane
		const staging = deriveStagingName(session);
		const idx = resolveWindow(staging, target) ?? (typeof target === "number" ? target : undefined);
		if (idx === undefined) return { ok: false, message: `No window '${target}'.` };
		swapViewPane(session, staging, idx);
		return { ok: true, message: `Switched to :${idx}`, details: { session, window: idx } };
	}

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

	if (process.env.TMUX) {
		const staging = deriveStagingName(session);
		const idx = resolveWindow(staging, target) ?? (typeof target === "number" ? target : undefined);
		if (idx === undefined) return { ok: false, message: `No window '${target}'.` };
		tryRun(`tmux kill-window -t ${staging}:${idx}`);
		const remaining = listWindows(session).length;
		return { ok: true, message: `Closed :${idx}. ${remaining} window(s) remain.`, details: { session, window: idx } };
	}

	const idx = resolveWindow(session, target);
	if (idx === undefined) return { ok: false, message: `No window '${target}' in session ${session}.` };
	if (process.env.TMUX && idx === getPiWindowIndex(session)) return { ok: false, message: `Error: window :${idx} is pi's pane and cannot be closed.` };
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

	const captureTarget = process.env.TMUX ? deriveStagingName(session) : session;
	const output = captureOutput(captureTarget, target);
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
	if (process.env.TMUX) {
		// Kill the staging session and the view pane
		const staging = deriveStagingName(session);
		tryRun(`tmux kill-session -t ${staging}`);
		tryRun(`tmux kill-pane -t ${session}:0.1`);
		return { ok: true, message: `Killed command session ${staging}.` };
	}

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
