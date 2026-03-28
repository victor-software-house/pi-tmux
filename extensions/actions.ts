/**
 * Shared session actions — single source of truth for both the tool and /tmux commands.
 *
 * Every action that mutates or queries tmux state lives here. The tool's execute()
 * and the command's handler() are thin wrappers that format results for their
 * respective interfaces.
 */
import type { AttachLayout, AutoFocus, ShellMode, WindowReuse } from "./types.js";
import { run, tryRun, isSessionAlive, isWindowIdle, listWindows, resolveWindow, captureOutput, deriveWindowName, tmuxEscape, commandSession, ensureStagingSession, ensureViewPane, createStagingWindow, swapViewPane, respawnStagingWindow, deriveStagingName, listManagedPanes, markManagedPane, setManagedPaneTitle, getPaneId, resolveManagedPane, getPaneLocation } from "./session.js";
import { attachToSession, closeAttachedSessions, hasAttachedPane } from "./terminal.js";
import { sendCommand, sendCommandToPane, createWindowWithCommand, startCommandInFirstWindow, clearSilenceForWindow, trackCompletionByPane } from "./signals.js";

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
	shellMode: ShellMode;
	target?: number | string;
}

export function actionRun(session: string, opts: RunOpts): ActionResult {
	const windowName = opts.name ? opts.name.slice(0, 30) : deriveWindowName(opts.command);

	// -------------------------------------------------------------------
	// Tmux mode: staging session + view pane swap (zero flash)
	// -------------------------------------------------------------------
	if (process.env.TMUX) {
		const staging = ensureStagingSession(session, opts.cwd);
		ensureViewPane(session, opts.cwd, opts.defaultLayout);

		const managedPanes = listManagedPanes(session);
		const visiblePane = managedPanes.find((pane) => pane.visible);

		if (opts.shellMode === "resume") {
			const target = opts.target ?? opts.name;
			const pane = target !== undefined ? resolveManagedPane(session, target) : visiblePane;
			if (!pane) {
				return { ok: false, message: target === undefined ? "Error: No managed pane to resume." : `Error: No pane '${target}'.` };
			}
			sendCommandToPane(pane.paneId, opts.command);
			const location = getPaneLocation(pane.paneId);
			const shouldShow = opts.autoFocus === "always";
			if (shouldShow && location?.session === staging) {
				swapViewPane(session, staging, location.windowIndex);
			}
			const visible = shouldShow ? true : pane.visible;
			return {
				ok: true,
				message: `Resumed pane ${pane.paneId} — ${pane.title}`,
				details: {
					session,
					paneId: pane.paneId,
					windowName: pane.title,
					created: false,
					reused: true,
					lifecycle: "resume-existing",
					visible,
				},
			};
		}

		const reusablePanes = managedPanes
			.filter((pane) => pane.session === staging && pane.idle)
			.sort((a, b) => b.windowIndex - a.windowIndex);

		let stagingIdx: number | undefined;
		let paneId: string | null = null;
		let lifecycle: "fresh-created" | "fresh-respawned" = "fresh-created";

		if (opts.windowReuse !== "never") {
			let candidate = reusablePanes.find((pane) => pane.title === opts.name);
			if (!candidate && !opts.name && opts.windowReuse === "last") {
				candidate = reusablePanes[0];
			}
			if (candidate) {
				stagingIdx = candidate.windowIndex;
				paneId = candidate.paneId;
				respawnStagingWindow(staging, stagingIdx, opts.cwd);
				tryRun(`tmux rename-window -t ${staging}:${stagingIdx} "${tmuxEscape(windowName)}"`);
				setManagedPaneTitle(paneId, windowName);
				lifecycle = "fresh-respawned";
			}
		}

		if (stagingIdx === undefined) {
			if (managedPanes.length >= opts.maxWindows) {
				return { ok: false, message: `Error: ${managedPanes.length} panes open (max: ${opts.maxWindows}). Close idle panes first.` };
			}
			stagingIdx = createStagingWindow(staging, opts.cwd, windowName);
			paneId = getPaneId(`${staging}:${stagingIdx}.0`);
			if (paneId) {
				markManagedPane(paneId, session, windowName);
			}
		}

		if (!paneId) {
			paneId = getPaneId(`${staging}:${stagingIdx}.0`);
		}
		if (paneId) {
			setManagedPaneTitle(paneId, windowName);
			sendCommandToPane(paneId, opts.command);
		}

		const shouldShow = opts.autoFocus === "always";
		if (shouldShow) {
			swapViewPane(session, staging, stagingIdx);
		}

		const verb = lifecycle === "fresh-created" ? "Started fresh pane" : "Respawned pane";
		return {
			ok: true,
			message: `${verb} ${paneId ?? "(unknown)"} — ${windowName}`,
			details: {
				session,
				stagingIdx,
				paneId: paneId ?? "",
				windowName,
				created: lifecycle === "fresh-created",
				reused: lifecycle === "fresh-respawned",
				lifecycle,
				visible: shouldShow,
			},
		};
	}

	// -------------------------------------------------------------------
	// Legacy mode: window-per-command
	// -------------------------------------------------------------------
	const alive = isSessionAlive(session);
	let windowIndex: number;
	let reused = false;

	if (opts.shellMode === "resume") {
		if (!alive) {
			return { ok: false, message: `Error: No active session '${session}' to resume.` };
		}
		const windows = listWindows(session);
		const resumeTarget = opts.target ?? opts.name;
		const activeWindow = windows.find((window) => window.active)?.index;
		const idx = resumeTarget !== undefined ? resolveWindow(session, resumeTarget) : activeWindow;
		if (idx === undefined) {
			return { ok: false, message: resumeTarget === undefined ? "Error: No active window to resume." : `Error: No window '${resumeTarget}' in session ${session}.` };
		}
		sendCommand(session, idx, opts.command);
		if (opts.autoFocus === "always") {
			tryRun(`tmux select-window -t ${session}:${idx}`);
		}
		return {
			ok: true,
			message: `Resumed window :${idx} — ${windows.find((window) => window.index === idx)?.title ?? windowName}`,
			details: { session, windowIndex: idx, windowName, created: false, reused: true, lifecycle: "resume-existing", visible: opts.autoFocus === "always" },
		};
	}

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

	// In tmux mode, attach means ensuring the visible CC split exists.
	// If a specific window is requested, prepare the split first, then swap it in.
	if (process.env.TMUX) {
		ensureViewPane(session, cwd, opts.layout);
		if (opts.window !== undefined) return actionFocus(session, opts.window);
		return { ok: true, message: "View pane ready." };
	}

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
		const remaining = listWindows(staging).length;
		return { ok: true, message: `Closed :${idx}. ${remaining} window(s) remain.`, details: { session, window: idx } };
	}

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

	const output = captureOutput(commandSession(session), target);
	return { ok: true, message: output, details: { session } };
}

// ---------------------------------------------------------------------------
// list — show windows and status
// ---------------------------------------------------------------------------

export function actionList(session: string): ActionResult {
	if (!isSessionAlive(session)) return { ok: false, message: `No active session '${session}'.` };

	const cmdSession = commandSession(session);
	const windows = listWindows(cmdSession);
	const attached = process.env.TMUX ? true : hasAttachedPane(session);
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

	const cmdSession = commandSession(session);
	const idleShells = new Set(["bash", "zsh", "sh", "fish", "dash"]);
	const raw = tryRun(`tmux list-windows -t ${cmdSession} -F "#{window_index}\t#{pane_current_command}\t#{pane_pid}"`);
	if (!raw) return { ok: true, message: "No windows to clear." };

	const idle = raw
		.split("\n")
		.map((line) => {
			const parts = line.split("\t");
			return { index: parseInt(parts[0] ?? "0", 10), cmd: parts[1] ?? "", pid: parts[2] ?? "" };
		})
		.filter((w) => idleShells.has(w.cmd) && !tryRun(`pgrep -P ${w.pid}`));

	if (idle.length === 0) return { ok: true, message: "No idle windows to clear." };

	for (const w of idle) {
		tryRun(`tmux kill-window -t ${cmdSession}:${w.index}`);
	}

	const remaining = listWindows(cmdSession).length;
	if (process.env.TMUX && remaining === 0) {
		// No command windows left — remove the view pane too
		tryRun(`tmux kill-pane -t ${session}:0.1`);
	}
	return { ok: true, message: `Cleared ${idle.length} idle window(s).` };
}

// ---------------------------------------------------------------------------
// mute — disable silence notifications for a window
// ---------------------------------------------------------------------------

export function actionMute(session: string, windowIndex: number): ActionResult {
	if (!isSessionAlive(session)) return { ok: false, message: `No active session '${session}'.` };

	const cmdSession = commandSession(session);
	clearSilenceForWindow(cmdSession, windowIndex);
	const windows = listWindows(cmdSession);
	const w = windows.find((win) => win.index === windowIndex);
	return { ok: true, message: `Muted silence alerts for "${w?.title ?? `window ${windowIndex}`}" (:${windowIndex}).` };
}
