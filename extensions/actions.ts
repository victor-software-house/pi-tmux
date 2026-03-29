/**
 * Shared session actions — single source of truth for both the tool and /tmux commands.
 *
 * Every action that mutates or queries tmux state lives here. The tool's execute()
 * and the command's handler() are thin wrappers that format results for their
 * respective interfaces.
 */
import type { AttachLayout, AutoFocus, ShellMode, WindowReuse } from "./types.js";
import { run, tryRun, isSessionAlive, isWindowIdle, listWindows, resolveWindow, captureOutput, deriveWindowName, tmuxEscape, commandSession, ensureStagingSession, ensureViewPane, createStagingWindow, swapViewPane, respawnStagingWindow, deriveStagingName, listManagedPanes, getPaneId, resolveManagedPane, waitForPaneQuiescence, tmuxSessionTarget } from "./session.js";
import { attachToSession, closeAttachedSessions, hasAttachedPane } from "./terminal.js";
import { sendCommand, sendCommandToPane, createWindowWithCommand, startCommandInFirstWindow, clearSilenceForWindow, trackCompletionByPane } from "./signals.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if the session is active. In tmux mode, checks the staging session. */
function hasActiveSession(session: string): boolean {
	if (process.env.TMUX) return isSessionAlive(commandSession(session));
	return isSessionAlive(session);
}

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
	/** The CC-attached host session for view panes (tmux mode). Defaults to session. */
	hostSession?: string;
	/** The tmux window index within the host session where Pi is running. */
	hostWindowIndex?: number;
}

export async function actionRun(session: string, opts: RunOpts): Promise<ActionResult> {
	const windowName = opts.name ? opts.name.slice(0, 30) : deriveWindowName(opts.command);

	// -------------------------------------------------------------------
	// Tmux mode: staging session + view pane swap (zero flash)
	// -------------------------------------------------------------------
	if (process.env.TMUX) {
		const host = opts.hostSession ?? session;
		const hostWin = opts.hostWindowIndex ?? 0;
		const staging = ensureStagingSession(session, opts.cwd);
		ensureViewPane(host, opts.cwd, opts.defaultLayout, hostWin);

		const managedPanes = listManagedPanes(session, host, hostWin);
		const visiblePane = managedPanes.find((pane) => pane.visible);

		if (opts.shellMode === "resume") {
			const target = opts.target ?? opts.name;
			const pane = target !== undefined ? resolveManagedPane(session, target, host, hostWin) : visiblePane;
			if (!pane) {
				return { ok: false, message: target === undefined ? "Error: No managed pane to resume." : `Error: No pane '${target}'.` };
			}
			sendCommandToPane(pane.paneId, opts.command);
			const shouldShow = opts.autoFocus === "always";
			if (shouldShow && !pane.visible) {
				swapViewPane(host, staging, pane.windowIndex, hostWin);
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
			.filter((pane) => !pane.visible && pane.idle)
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
				respawnStagingWindow(staging, stagingIdx, opts.cwd);
				tryRun(`tmux rename-window -t ${tmuxSessionTarget(staging)}:${stagingIdx} "${tmuxEscape(windowName)}"`);
				paneId = getPaneId(`${staging}:${stagingIdx}.0`);
				lifecycle = "fresh-respawned";
			}
		}

		if (stagingIdx === undefined) {
			if (managedPanes.length >= opts.maxWindows) {
				return { ok: false, message: `Error: ${managedPanes.length} panes open (max: ${opts.maxWindows}). Close idle panes first.` };
			}
			stagingIdx = createStagingWindow(staging, opts.cwd, windowName);
			paneId = getPaneId(`${staging}:${stagingIdx}.0`);
		}

		if (!paneId) {
			paneId = getPaneId(`${staging}:${stagingIdx}.0`);
		}
		if (paneId) {
			await waitForPaneQuiescence(paneId);
			sendCommandToPane(paneId, opts.command);
		}

		const shouldShow = opts.autoFocus === "always";
		if (shouldShow) {
			swapViewPane(host, staging, stagingIdx, hostWin);
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
			tryRun(`tmux select-window -t ${tmuxSessionTarget(session)}:${idx}`);
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
		tryRun(`tmux select-window -t ${tmuxSessionTarget(session)}:${windowIndex}`);
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
	opts: { layout: AttachLayout; window?: number | string; hostSession?: string; hostWindowIndex?: number },
): ActionResult {
	if (!hasActiveSession(session)) return { ok: false, message: `No active session '${session}'.` };

	// In tmux mode, attach creates a visible split/tab via CC.
	if (process.env.TMUX) {
		const host = opts.hostSession ?? session;
		const hostWin = opts.hostWindowIndex ?? 0;
		if (hasAttachedPane(host, hostWin)) {
			if (opts.window !== undefined) return actionFocus(session, opts.window, host, hostWin);
			return { ok: true, message: "Already attached." };
		}
		const { openTerminal } = require("./terminal-tmux.js") as typeof import("./terminal-tmux.js");
		const msg = openTerminal(host, opts.layout, undefined, hostWin);
		if (opts.window !== undefined) {
			const focus = actionFocus(session, opts.window, host, hostWin);
			return { ok: focus.ok, message: `${msg}\n${focus.message}` };
		}
		return { ok: true, message: msg };
	}

	const targetIdx = opts.window !== undefined ? resolveWindow(session, opts.window) : undefined;

	if (hasAttachedPane(session)) {
		if (targetIdx !== undefined) {
			tryRun(`tmux select-window -t ${tmuxSessionTarget(session)}:${targetIdx}`);
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

export function actionFocus(session: string, target: number | string, hostSession?: string, hostWindowIndex = 0): ActionResult {
	if (!hasActiveSession(session)) return { ok: false, message: `No active session '${session}'.` };

	if (process.env.TMUX) {
		const host = hostSession ?? session;
		const pane = resolveManagedPane(session, target, host, hostWindowIndex);
		if (!pane) return { ok: false, message: `No pane '${target}'.` };
		if (pane.visible) {
			return { ok: true, message: `Pane ${pane.paneId} is already visible.`, details: { session, paneId: pane.paneId, window: pane.windowIndex } };
		}
		swapViewPane(host, deriveStagingName(session), pane.windowIndex, hostWindowIndex);
		return { ok: true, message: `Focused pane ${pane.paneId} — ${pane.title}`, details: { session, paneId: pane.paneId, window: pane.windowIndex } };
	}

	const idx = resolveWindow(session, target);
	if (idx === undefined) return { ok: false, message: `No window '${target}' in session ${session}.` };
	tryRun(`tmux select-window -t ${tmuxSessionTarget(session)}:${idx}`);
	return { ok: true, message: `Switched to :${idx}`, details: { session, window: idx } };
}

// ---------------------------------------------------------------------------
// close — kill a single window
// ---------------------------------------------------------------------------

export function actionClose(session: string, target: number | string, hostSession?: string, hostWindowIndex = 0): ActionResult {
	if (!hasActiveSession(session)) return { ok: false, message: `No active session '${session}'.` };

	if (process.env.TMUX) {
		const host = hostSession ?? session;
		const staging = deriveStagingName(session);
		const pane = resolveManagedPane(session, target, host, hostWindowIndex);
		if (!pane) return { ok: false, message: `No pane '${target}'.` };
		if (pane.visible) {
			// Kill the view pane directly, then kill the staging window
			tryRun(`tmux kill-pane -t ${tmuxSessionTarget(host)}:${hostWindowIndex}.1`);
			tryRun(`tmux kill-window -t ${tmuxSessionTarget(staging)}:${pane.windowIndex}`);
		} else {
			tryRun(`tmux kill-window -t ${tmuxSessionTarget(staging)}:${pane.windowIndex}`);
		}
		const remaining = listManagedPanes(session, host, hostWindowIndex).length;
		return { ok: true, message: `Closed pane ${pane.paneId}. ${remaining} managed pane(s) remain.`, details: { session, paneId: pane.paneId, window: pane.windowIndex } };
	}

	const idx = resolveWindow(session, target);
	if (idx === undefined) return { ok: false, message: `No window '${target}' in session ${session}.` };
	tryRun(`tmux kill-window -t ${tmuxSessionTarget(session)}:${idx}`);
	const remaining = isSessionAlive(session) ? listWindows(session).length : 0;
	const msg = remaining > 0 ? `Closed :${idx}. ${remaining} window(s) remain.` : `Closed :${idx}. Session ended.`;
	return { ok: true, message: msg, details: { session, window: idx, sessionEnded: remaining === 0 } };
}

// ---------------------------------------------------------------------------
// peek — capture recent output
// ---------------------------------------------------------------------------

export function actionPeek(session: string, target: number | string | "all", hostSession?: string, hostWindowIndex = 0): ActionResult {
	if (!hasActiveSession(session)) return { ok: false, message: `No active session '${session}'.` };

	if (process.env.TMUX) {
		const host = hostSession ?? session;
		if (target === "all") {
			const panes = listManagedPanes(session, host, hostWindowIndex);
			if (panes.length === 0) return { ok: true, message: "(no managed panes)", details: { session } };
			const output = panes
				.map((pane) => {
					const paneOutput = tryRun(`tmux capture-pane -t ${pane.paneId} -p -S -50`) ?? "(no output)";
					return `-- pane ${pane.paneId}: ${pane.title} (${pane.visible ? "visible" : "offscreen"}, ${pane.idle ? "idle" : "running"}) --\n${paneOutput}`;
				})
				.join("\n\n");
			return { ok: true, message: output, details: { session } };
		}

		const pane = resolveManagedPane(session, target, host, hostWindowIndex);
		if (!pane) return { ok: false, message: `No pane '${target}'.` };
		const output = tryRun(`tmux capture-pane -t ${pane.paneId} -p -S -50`) ?? "(no output)";
		return { ok: true, message: output, details: { session, paneId: pane.paneId, window: pane.windowIndex } };
	}

	const output = captureOutput(commandSession(session), target === "all" || typeof target === "number" ? target : "all");
	return { ok: true, message: output, details: { session } };
}

// ---------------------------------------------------------------------------
// list — show windows and status
// ---------------------------------------------------------------------------

export function actionList(session: string, hostSession?: string, hostWindowIndex = 0): ActionResult {
	if (!hasActiveSession(session)) return { ok: false, message: `No active session '${session}'.` };

	if (process.env.TMUX) {
		const panes = listManagedPanes(session, hostSession ?? session, hostWindowIndex);
		const formatted = panes.map((pane) => `  :${pane.windowIndex}  ${pane.title}  (${pane.visible ? "visible" : "offscreen"}, ${pane.idle ? "idle" : "running"}, pane ${pane.paneId})`);
		const header = `Session ${session} — ${panes.length} managed pane(s) (attached)`;
		return { ok: true, message: `${header}\n${formatted.join("\n")}`, details: { session, panes, attached: true } };
	}

	const cmdSession = commandSession(session);
	const windows = listWindows(cmdSession);
	const attached = hasAttachedPane(session);
	const formatted = windows.map((w) => `  :${w.index}  ${w.title}${w.active ? "  (active)" : ""}`);
	const header = `Session ${session} — ${windows.length} window(s)${attached ? " (attached)" : ""}`;
	return { ok: true, message: `${header}\n${formatted.join("\n")}`, details: { session, windows, attached } };
}

// ---------------------------------------------------------------------------
// kill — terminate session
// ---------------------------------------------------------------------------

export function actionKill(session: string, hostSession?: string, hostWindowIndex = 0): ActionResult {
	if (!hasActiveSession(session)) return { ok: false, message: `No active session '${session}'.` };
	if (process.env.TMUX) {
		const host = hostSession ?? session;
		const staging = deriveStagingName(session);
		// Kill the view pane first — it was swapped from staging into the host,
		// so kill-session on staging won't reach it.
		tryRun(`tmux kill-pane -t ${tmuxSessionTarget(host)}:${hostWindowIndex}.1`);
		tryRun(`tmux kill-session -t ${tmuxSessionTarget(staging)}`);
		const { closeAttachedSessions: closeTmux } = require("./terminal-tmux.js") as typeof import("./terminal-tmux.js");
		closeTmux(host, hostWindowIndex);
		return { ok: true, message: `Killed command session ${staging}.` };
	}

	closeAttachedSessions(session);
	run(`tmux kill-session -t ${tmuxSessionTarget(session)}`);
	return { ok: true, message: `Killed session ${session}.` };
}

// ---------------------------------------------------------------------------
// clear — kill idle windows
// ---------------------------------------------------------------------------

export function actionClear(session: string): ActionResult {
	if (!hasActiveSession(session)) return { ok: false, message: "No active session." };

	if (process.env.TMUX) {
		const paneId = process.env.TMUX_PANE;
		const hostInfo = paneId ? tryRun(`tmux display -p -t ${paneId} "#{session_name}\t#{window_index}"`) : null;
		const host = hostInfo?.split("\t")[0]?.trim() ?? session;
		const hostWin = Number.parseInt(hostInfo?.split("\t")[1] ?? "", 10) || 0;
		const staging = deriveStagingName(session);
		const idlePanes = listManagedPanes(session, host, hostWin).filter((pane) => pane.idle);
		if (idlePanes.length === 0) return { ok: true, message: "No idle panes to clear." };
		for (const pane of idlePanes) {
			if (pane.visible) {
				tryRun(`tmux kill-pane -t ${tmuxSessionTarget(host)}:${hostWin}.1`);
				tryRun(`tmux kill-window -t ${tmuxSessionTarget(staging)}:${pane.windowIndex}`);
			} else {
				tryRun(`tmux kill-window -t ${tmuxSessionTarget(staging)}:${pane.windowIndex}`);
			}
		}
		return { ok: true, message: `Cleared ${idlePanes.length} idle pane(s).` };
	}

	const cmdSession = commandSession(session);
	const raw = tryRun(`tmux list-windows -t ${cmdSession} -F "#{window_index}\t#{pane_current_command}\t#{pane_pid}"`);
	if (!raw) return { ok: true, message: "No windows to clear." };

	const idle = raw
		.split("\n")
		.map((line) => {
			const parts = line.split("\t");
			return { index: parseInt(parts[0] ?? "0", 10), cmd: parts[1] ?? "", pid: parts[2] ?? "" };
		})
		.filter((w) => ["bash", "zsh", "sh", "fish", "dash"].includes(w.cmd) && !tryRun(`pgrep -P ${w.pid}`));

	if (idle.length === 0) return { ok: true, message: "No idle windows to clear." };

	for (const w of idle) {
		tryRun(`tmux kill-window -t ${tmuxSessionTarget(cmdSession)}:${w.index}`);
	}

	const remaining = listWindows(cmdSession).length;
	if (process.env.TMUX && remaining === 0) {
		const pId = process.env.TMUX_PANE;
		const hInfo = pId ? tryRun(`tmux display -p -t ${pId} "#{session_name}\t#{window_index}"`) : null;
		const h = hInfo?.split("\t")[0]?.trim() ?? session;
		const hw = Number.parseInt(hInfo?.split("\t")[1] ?? "", 10) || 0;
		tryRun(`tmux kill-pane -t ${tmuxSessionTarget(h)}:${hw}.1`);
	}
	return { ok: true, message: `Cleared ${idle.length} idle window(s).` };
}

// ---------------------------------------------------------------------------
// mute — disable silence notifications for a window
// ---------------------------------------------------------------------------

export function actionMute(session: string, target: number | string, hostSession?: string, hostWindowIndex = 0): ActionResult {
	if (!hasActiveSession(session)) return { ok: false, message: `No active session '${session}'.` };

	if (process.env.TMUX) {
		const pane = resolveManagedPane(session, target, hostSession ?? session, hostWindowIndex);
		if (!pane) return { ok: false, message: `No pane '${target}'.` };
		clearSilenceForWindow(deriveStagingName(session), pane.windowIndex);
		return { ok: true, message: `Muted silence alerts for pane ${pane.paneId} — ${pane.title}.` };
	}

	if (typeof target !== "number") {
		return { ok: false, message: `Error: mute requires a numeric window index outside tmux mode.` };
	}
	const cmdSession = commandSession(session);
	clearSilenceForWindow(cmdSession, target);
	const windows = listWindows(cmdSession);
	const w = windows.find((win) => win.index === target);
	return { ok: true, message: `Muted silence alerts for "${w?.title ?? `window ${target}`}" (:${target}).` };
}
