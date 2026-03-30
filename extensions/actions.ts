/**
 * Shared session actions — single source of truth for both the tool and /tmux commands.
 *
 * Every action that mutates or queries tmux state lives here. The tool's execute()
 * and the command's handler() are thin wrappers that format results for their
 * respective interfaces.
 *
 * All actions assume tmux CC mode. Non-tmux usage is gated at the extension
 * entry point (index.ts) and never reaches this module.
 */
import type { AttachLayout, AutoFocus, ShellMode, WindowReuse } from "./types.js";
import {
	tryRun,
	isSessionAlive,
	deriveWindowName,
	tmuxEscape,
	commandSession,
	ensureStagingSession,
	ensureViewPane,
	createStagingWindow,
	swapViewPane,
	respawnStagingWindow,
	deriveStagingName,
	listManagedPanes,
	getPaneId,
	resolveManagedPane,
	waitForPaneQuiescence,
	tmuxSessionTarget,
} from "./session.js";
import { hasAttachedPane } from "./terminal-tmux.js";
import { sendCommandToPane, clearSilenceForWindow } from "./signals.js";

// ---------------------------------------------------------------------------
// Host target
// ---------------------------------------------------------------------------

/** Identity of the CC-attached host session and window where Pi is running. */
export interface HostTarget {
	/** The tmux session name Pi is running in (CC-attached). */
	session: string;
	/** The tmux window index within that session where Pi's pane lives. */
	windowIndex: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if the staging session is active. */
function hasActiveSession(session: string): boolean {
	return isSessionAlive(commandSession(session));
}

/**
 * Capture scrollback from a pane, returning an excerpt and truncation metadata.
 * Uses `capture-pane -S -` for full scrollback, then takes the last `limit` lines.
 */
function capturePaneExcerpt(paneId: string, limit: number): { excerpt: string; meta: string } {
	const raw = tryRun(`tmux capture-pane -t ${paneId} -p -S -`) ?? "";
	const allLines = raw.split("\n");
	// Trim trailing empty lines for accurate count
	while (allLines.length > 0 && (allLines[allLines.length - 1] ?? "").trim() === "") allLines.pop();
	const totalLines = allLines.length;
	if (totalLines === 0) return { excerpt: "(no output)", meta: "" };
	const shown = allLines.slice(-limit);
	const omitted = totalLines - shown.length;
	const excerpt = shown.join("\n");
	const meta = omitted > 0 ? `(${totalLines} lines total, showing last ${shown.length})` : "";
	return { excerpt, meta };
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
	host: HostTarget;
}

export async function actionRun(session: string, opts: RunOpts): Promise<ActionResult> {
	const windowName = opts.name ? opts.name.slice(0, 30) : deriveWindowName(opts.command);
	const { host } = opts;
	const staging = ensureStagingSession(session, opts.cwd);
	ensureViewPane(host.session, opts.cwd, opts.defaultLayout, host.windowIndex);

	const managedPanes = listManagedPanes(session, host.session, host.windowIndex);
	const visiblePane = managedPanes.find((pane) => pane.visible);

	// Resume mode: send command to an existing pane
	if (opts.shellMode === "resume") {
		const target = opts.target ?? opts.name;
		const pane = target !== undefined ? resolveManagedPane(session, target, host.session, host.windowIndex) : visiblePane;
		if (!pane) {
			return { ok: false, message: target === undefined ? "Error: No managed pane to resume." : `Error: No pane '${target}'.` };
		}
		sendCommandToPane(pane.paneId, opts.command);
		const shouldShow = opts.autoFocus === "always";
		if (shouldShow && !pane.visible) {
			swapViewPane(host.session, pane.paneId, host.windowIndex);
		}
		const visible = shouldShow ? true : pane.visible;
		return {
			ok: true,
			message: `Resumed pane ${pane.paneId} ��� ${pane.title}`,
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

	// Fresh mode: find or create a staging window
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
			respawnStagingWindow(staging, stagingIdx, opts.cwd, windowName);
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
	if (shouldShow && paneId) {
		swapViewPane(host.session, paneId, host.windowIndex);
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

// ---------------------------------------------------------------------------
// attach — open terminal pane, or acknowledge if already attached
// ---------------------------------------------------------------------------

export function actionAttach(
	session: string,
	cwd: string,
	opts: { layout: AttachLayout; window?: number | string; host: HostTarget },
): ActionResult {
	if (!hasActiveSession(session)) return { ok: false, message: `No active session '${session}'.` };

	const { host } = opts;
	if (hasAttachedPane(host.session, host.windowIndex)) {
		if (opts.window !== undefined) return actionFocus(session, opts.window, host);
		return { ok: true, message: "Already attached." };
	}
	const { openTerminal } = require("./terminal-tmux.js") as typeof import("./terminal-tmux.js");
	const msg = openTerminal(host.session, opts.layout, undefined, host.windowIndex);
	if (opts.window !== undefined) {
		const focus = actionFocus(session, opts.window, host);
		return { ok: focus.ok, message: `${msg}\n${focus.message}` };
	}
	return { ok: true, message: msg };
}

// ---------------------------------------------------------------------------
// focus — swap a staging pane into the view
// ---------------------------------------------------------------------------

export function actionFocus(session: string, target: number | string, host: HostTarget): ActionResult {
	if (!hasActiveSession(session)) return { ok: false, message: `No active session '${session}'.` };

	const pane = resolveManagedPane(session, target, host.session, host.windowIndex);
	if (!pane) return { ok: false, message: `No pane '${target}'.` };
	if (pane.visible) {
		return { ok: true, message: `Pane ${pane.paneId} is already visible.`, details: { session, paneId: pane.paneId, window: pane.windowIndex } };
	}
	swapViewPane(host.session, pane.paneId, host.windowIndex);
	return { ok: true, message: `Focused pane ${pane.paneId} — ${pane.title}`, details: { session, paneId: pane.paneId, window: pane.windowIndex } };
}

// ---------------------------------------------------------------------------
// close — kill a single pane
// ---------------------------------------------------------------------------

export function actionClose(session: string, target: number | string, host: HostTarget): ActionResult {
	if (!hasActiveSession(session)) return { ok: false, message: `No active session '${session}'.` };

	const pane = resolveManagedPane(session, target, host.session, host.windowIndex);
	if (!pane) return { ok: false, message: `No pane '${target}'.` };
	if (pane.visible) {
		tryRun(`tmux kill-pane -t ${tmuxSessionTarget(host.session)}:${host.windowIndex}.1`);
	} else {
		tryRun(`tmux kill-pane -t ${pane.paneId}`);
	}
	const remaining = listManagedPanes(session, host.session, host.windowIndex).length;
	return { ok: true, message: `Closed pane ${pane.paneId}. ${remaining} managed pane(s) remain.`, details: { session, paneId: pane.paneId, window: pane.windowIndex } };
}

// ---------------------------------------------------------------------------
// peek — capture recent output
// ---------------------------------------------------------------------------

export function actionPeek(session: string, target: number | string | "all", host: HostTarget, limit = 50): ActionResult {
	if (!hasActiveSession(session)) return { ok: false, message: `No active session '${session}'.` };

	if (target === "all") {
		const panes = listManagedPanes(session, host.session, host.windowIndex);
		if (panes.length === 0) return { ok: true, message: "(no managed panes)", details: { session } };
		const output = panes
			.map((pane) => {
				const { excerpt, meta } = capturePaneExcerpt(pane.paneId, limit);
				const status = `${pane.visible ? "visible" : "offscreen"}, ${pane.idle ? "idle" : "running"}`;
				return `-- pane ${pane.paneId}: ${pane.title} (${status})${meta} --\n${excerpt}`;
			})
			.join("\n\n");
		return { ok: true, message: output, details: { session } };
	}

	const pane = resolveManagedPane(session, target, host.session, host.windowIndex);
	if (!pane) return { ok: false, message: `No pane '${target}'.` };
	const { excerpt, meta } = capturePaneExcerpt(pane.paneId, limit);
	const output = meta ? `${meta}\n${excerpt}` : excerpt;
	return { ok: true, message: output, details: { session, paneId: pane.paneId, window: pane.windowIndex } };
}

// ---------------------------------------------------------------------------
// list — show panes and status
// ---------------------------------------------------------------------------

export function actionList(session: string, host: HostTarget): ActionResult {
	if (!hasActiveSession(session)) return { ok: false, message: `No active session '${session}'.` };

	const panes = listManagedPanes(session, host.session, host.windowIndex);
	const attached = hasAttachedPane(host.session, host.windowIndex);
	const formatted = panes.map((pane) => `  :${pane.windowIndex}  ${pane.title}  (${pane.visible ? "visible" : "offscreen"}, ${pane.idle ? "idle" : "running"}, pane ${pane.paneId})`);
	const attachState = attached ? "attached" : "detached";
	const header = `Session ${session} — ${panes.length} managed pane(s) (${attachState})`;
	return { ok: true, message: `${header}\n${formatted.join("\n")}`, details: { session, panes, attached } };
}

// ---------------------------------------------------------------------------
// kill — terminate session
// ---------------------------------------------------------------------------

export function actionKill(session: string, host: HostTarget): ActionResult {
	if (!hasActiveSession(session)) return { ok: false, message: `No active session '${session}'.` };

	const staging = deriveStagingName(session);
	// Kill the view pane first — it was swapped from staging into the host,
	// so kill-session on staging won't reach it.
	tryRun(`tmux kill-pane -t ${tmuxSessionTarget(host.session)}:${host.windowIndex}.1`);
	tryRun(`tmux kill-session -t ${tmuxSessionTarget(staging)}`);
	const { closeAttachedSessions: closeTmux } = require("./terminal-tmux.js") as typeof import("./terminal-tmux.js");
	closeTmux(host.session, host.windowIndex);
	return { ok: true, message: `Killed command session ${staging}.` };
}

// ---------------------------------------------------------------------------
// clear — kill idle panes
// ---------------------------------------------------------------------------

export function actionClear(session: string, host: HostTarget): ActionResult {
	if (!hasActiveSession(session)) return { ok: false, message: "No active session." };

	const idlePanes = listManagedPanes(session, host.session, host.windowIndex).filter((pane) => pane.idle);
	if (idlePanes.length === 0) return { ok: true, message: "No idle panes to clear." };
	for (const pane of idlePanes) {
		if (pane.visible) {
			tryRun(`tmux kill-pane -t ${tmuxSessionTarget(host.session)}:${host.windowIndex}.1`);
		} else {
			tryRun(`tmux kill-pane -t ${pane.paneId}`);
		}
	}
	return { ok: true, message: `Cleared ${idlePanes.length} idle pane(s).` };
}

// ---------------------------------------------------------------------------
// mute — disable silence notifications for a pane
// ---------------------------------------------------------------------------

export function actionMute(session: string, target: number | string, host: HostTarget): ActionResult {
	if (!hasActiveSession(session)) return { ok: false, message: `No active session '${session}'.` };

	const pane = resolveManagedPane(session, target, host.session, host.windowIndex);
	if (!pane) return { ok: false, message: `No pane '${target}'.` };
	clearSilenceForWindow(deriveStagingName(session), pane.windowIndex);
	return { ok: true, message: `Muted silence alerts for pane ${pane.paneId} — ${pane.title}.` };
}
