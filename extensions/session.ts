/**
 * tmux session primitives — process execution, project root resolution,
 * session identity, and window introspection.
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ManagedPaneInfo, WindowInfo } from "./types.js";

/** Run a shell command synchronously, returning trimmed stdout. Throws on failure. */
export function run(cmd: string): string {
	return execSync(cmd, { encoding: "utf-8", timeout: 10_000 }).trim();
}

const IDLE_SHELLS = new Set(["bash", "zsh", "sh", "fish", "dash", "ksh", "tcsh", "csh"]);
const MANAGED_PANE_MARK = "1";

/** Run a shell command, returning stdout on success or null on any error. */
export function tryRun(cmd: string): string | null {
	try {
		return run(cmd);
	} catch {
		return null;
	}
}

/**
 * Resolve the project root for tmux session scoping.
 * Uses git worktree root when available, otherwise falls back to cwd.
 */
export function resolveProjectRoot(cwd: string): string {
	try {
		return execSync("git rev-parse --show-toplevel", { encoding: "utf-8", cwd, timeout: 5_000 }).trim();
	} catch {
		return cwd;
	}
}

/** Derive a deterministic, human-readable tmux session name from a directory path. */
export function deriveSessionName(projectRoot: string): string {
	const dirName = projectRoot.split("/").pop() || "pi";
	// tmux silently renames sessions starting with '.' to '_', then all
	// subsequent send-keys/has-session calls using the original name fail.
	// Strip leading dots to keep the name stable.
	const sanitized = dirName.replace(/^\.+/, "") || "pi";
	const short = sanitized.slice(0, 16).toLowerCase();
	const fingerprint = createHash("md5").update(projectRoot).digest("hex").slice(0, 8);
	return `${short}-${fingerprint}`;
}

/** Build an exact tmux session target to avoid prefix matches. */
export function tmuxSessionTarget(name: string): string {
	return `=${name}`;
}

/** Quote a shell argument so interactive shells do not reinterpret it. */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Check whether a tmux session with the given name is alive. */
export function isSessionAlive(name: string): boolean {
	return tryRun(`tmux has-session -t ${tmuxSessionTarget(name)} 2>/dev/null && echo ok`) === "ok";
}

/**
 * Resolve a window target (index or name string) to a window index.
 * Returns undefined if not found.
 */
export function resolveWindow(sessionName: string, target: number | string): number | undefined {
	if (typeof target === "number") return target;
	const windows = listWindows(sessionName);
	return windows.find((w) => w.title === target)?.index;
}

// ---------------------------------------------------------------------------
// Tmux mode: non-CC command creation + CC view pane
// ---------------------------------------------------------------------------

/**
 * Local name for the separate tmux session where command windows are created.
 *
 * Background from the iTerm2/tmux CC experiments:
 * - creating a new tmux window inside the CC-attached session flashes because
 *   iTerm2 briefly renders a new tab for `%window-add`
 * - creating the window in a different tmux session that is not attached to CC
 *   does not flash
 * - later, `swap-pane` can move that pane into the visible split of the CC
 *   session with no tab creation and no observed flash
 *
 * "staging" is just a local debugging label for that non-CC session.
 */
export function deriveStagingName(session: string): string {
	return `${session}-stg`;
}

/**
 * Ensure the staging session exists. Returns the staging session name.
 * Staging is a regular tmux session not attached to CC — windows created here
 * don't appear as iTerm2 tabs.
 */
export function ensureStagingSession(session: string, cwd: string): string {
	const staging = deriveStagingName(session);
	if (!isSessionAlive(staging)) {
		run(`tmux new-session -d -s ${staging} -c "${cwd}"`);
	}
	return staging;
}

/**
 * Ensure view pane exists (pane 1 of window 0 in the CC session).
 * This is the single pane alongside pi where command output is displayed.
 * Returns the pane ID.
 */
export function ensureViewPane(session: string, cwd: string, layout: string): string {
	const panes = tryRun(`tmux list-panes -t ${tmuxSessionTarget(session)}:0 -F "#{pane_index} #{pane_id}"`);
	const existing = panes?.split("\n").find((l) => l.startsWith("1 "));
	if (existing) return existing.split(" ")[1] ?? "";
	const flag = layout === "split-horizontal" ? "-v" : "-h";
	const raw = run(`tmux split-window ${flag} -t ${tmuxSessionTarget(session)}:0 -c "${cwd}" -d -P -F "#{pane_id}"`);
	return raw.trim();
}

/**
 * Create a new window in the staging session. Returns window index.
 * No CC involvement — no tab flash.
 */
export function createStagingWindow(staging: string, cwd: string, name: string): number {
	const safeName = name.slice(0, 30);
	run(`tmux new-window -d -t ${tmuxSessionTarget(staging)} -n "${tmuxEscape(safeName)}" -c "${cwd}"`);
	// Get the index of the window we just created (last window by index)
	const raw = tryRun(`tmux list-windows -t ${tmuxSessionTarget(staging)} -F "#{window_index}\t#{window_name}"`);
	if (!raw) return 0;
	for (const line of raw.split("\n").reverse()) {
		const parts = line.split("\t");
		if (parts[1] === safeName) return parseInt(parts[0] ?? "0", 10);
	}
	return 0;
}

/**
 * Swap the visible command pane in the CC session with a pane from the
 * non-CC staging session.
 *
 * This preserves the behaviour discovered in manual testing:
 * - the command window is born outside the CC-attached session
 * - `swap-pane` changes what is visible in pane 1 of window 0
 * - no new CC window/tab is created during the switch
 * - the pane shown in the CC split behaves like the kind of native CC pane the
 *   operator wants while it is resident there
 *
 * We intentionally use `swap-pane` rather than break/join or hidden-window
 * tricks because those earlier approaches either flashed or disturbed layout.
 */
export function swapViewPane(session: string, staging: string, stagingIdx: number): void {
	run(`tmux swap-pane -d -s ${tmuxSessionTarget(session)}:0.1 -t ${tmuxSessionTarget(staging)}:${stagingIdx}.0`);
}

/**
 * Respawn an idle staging window with a fresh shell (no new window creation).
 */
export function respawnStagingWindow(staging: string, windowIdx: number, cwd: string): void {
	run(`tmux respawn-pane -k -t ${tmuxSessionTarget(staging)}:${windowIdx}.0 -c "${cwd}"`);
}

/** Mark a pane as managed by pi-tmux for a specific project session. */
export function markManagedPane(paneId: string, ownerSession: string, title: string): void {
	setPaneOption(paneId, "managed", MANAGED_PANE_MARK);
	setPaneOption(paneId, "owner_session", ownerSession);
	setPaneOption(paneId, "title", title);
}

/** Update the logical title stored on a managed pane. */
export function setManagedPaneTitle(paneId: string, title: string): void {
	setPaneOption(paneId, "title", title);
}

/** Read the current pane ID for a window target. Returns null if unavailable. */
export function getPaneId(target: string): string | null {
	return tryRun(`tmux display -p -t ${target} "#{pane_id}"`);
}

/** Return true if a command name represents an idle interactive shell. */
export function isIdleShellCommand(command: string): boolean {
	return IDLE_SHELLS.has(command);
}

/** Return the current tmux location of a pane. */
export function getPaneLocation(paneId: string): { session: string; windowIndex: number; paneIndex: number } | null {
	const raw = tryRun(`tmux display -p -t ${paneId} "#{session_name}\t#{window_index}\t#{pane_index}"`);
	if (!raw) return null;
	const parts = raw.split("\t");
	const session = parts[0] ?? "";
	const windowIndex = Number.parseInt(parts[1] ?? "", 10);
	const paneIndex = Number.parseInt(parts[2] ?? "", 10);
	if (!session || Number.isNaN(windowIndex) || Number.isNaN(paneIndex)) return null;
	return { session, windowIndex, paneIndex };
}

/** List all managed panes for a project session across the CC and staging sessions. */
export function listManagedPanes(ownerSession: string): ManagedPaneInfo[] {
	const sessions = [ownerSession, deriveStagingName(ownerSession)].filter((name, index, all) => isSessionAlive(name) && all.indexOf(name) === index);
	if (sessions.length === 0) return [];

	const panes: ManagedPaneInfo[] = [];
	for (const sessionName of sessions) {
		const raw = tryRun(
			`tmux list-panes -s -t ${tmuxSessionTarget(sessionName)} -F "#{pane_id}\t#{session_name}\t#{window_index}\t#{pane_index}\t#{pane_active}\t#{pane_current_command}\t#{pane_pid}\t#{@pi_managed}\t#{@pi_owner_session}\t#{@pi_title}"`,
		);
		if (!raw) continue;
		for (const line of raw.split("\n")) {
			const pane = parseManagedPaneLine(line, ownerSession);
			if (!pane) continue;
			panes.push(pane);
		}
	}

	return panes.sort((a, b) => {
		if (a.visible !== b.visible) return a.visible ? -1 : 1;
		if (a.session !== b.session) return a.session.localeCompare(b.session);
		if (a.windowIndex !== b.windowIndex) return a.windowIndex - b.windowIndex;
		return a.paneIndex - b.paneIndex;
	});
}

/** Find one managed pane by pane ID, logical title, or current location index. */
export function resolveManagedPane(ownerSession: string, target: number | string): ManagedPaneInfo | undefined {
	const panes = listManagedPanes(ownerSession);
	if (typeof target === "number") {
		return panes.find((pane) => pane.windowIndex === target);
	}
	return panes.find((pane) => pane.paneId === target || pane.title === target);
}

/**
 * Return the session where command windows live.
 * In tmux (CC) mode: the staging session. Outside tmux: the session itself.
 */
export function commandSession(session: string): string {
	return process.env.TMUX ? deriveStagingName(session) : session;
}

/** List all windows in a tmux session. Operates on the given session name as-is. */
export function listWindows(sessionName: string): WindowInfo[] {
	const raw = tryRun(`tmux list-windows -t ${tmuxSessionTarget(sessionName)} -F "#{window_index}\t#{window_name}\t#{window_active}"`);
	if (!raw) return [];
	return raw.split("\n").map((line) => {
		const parts = line.split("\t");
		return {
			index: parseInt(parts[0] ?? "0", 10),
			title: parts[1] ?? "",
			active: parts[2] === "1",
		};
	});
}

/** Capture scrollback from one or all windows. Returns formatted output. */
export function captureOutput(sessionName: string, target: number | "all"): string {
	if (target !== "all") {
		return tryRun(`tmux capture-pane -t ${tmuxSessionTarget(sessionName)}:${target} -p -S -50`) ?? "(no output)";
	}
	const windows = listWindows(sessionName);
	if (windows.length === 0) return "(no windows)";
	return windows
		.map((w) => {
			const paneOutput = tryRun(`tmux capture-pane -t ${tmuxSessionTarget(sessionName)}:${w.index} -p -S -50`) ?? "(no output)";
			return `-- window ${w.index}: ${w.title} --\n${paneOutput}`;
		})
		.join("\n\n");
}

/**
 * Check whether a tmux window is idle — shell at prompt with no running child processes.
 * Uses the same logic as /tmux:clear.
 */
export function isWindowIdle(sessionName: string, windowIndex: number): boolean {
	const raw = tryRun(
		`tmux list-windows -t ${tmuxSessionTarget(sessionName)} -F "#{window_index}\t#{pane_current_command}\t#{pane_pid}"`,
	);
	if (!raw) return false;
	for (const line of raw.split("\n")) {
		const parts = line.split("\t");
		const idx = Number.parseInt(parts[0] ?? "", 10);
		if (idx !== windowIndex) continue;
		const cmd = parts[1] ?? "";
		const pid = parts[2] ?? "";
		if (!isIdleShellCommand(cmd)) return false;
		return !tryRun(`pgrep -P ${pid}`);
	}
	return false;
}

/**
 * Derive a short window name from a shell command string.
 * Takes the first word (executable name without path), capped at 30 chars.
 */
export function deriveWindowName(command: string): string {
	return (command.trim().split(/[|;&\s]/)[0]?.split("/").pop() || "shell").slice(0, 30);
}

function setPaneOption(paneId: string, key: string, value: string): void {
	run(`tmux set-option -p -t ${paneId} @pi_${key} "${tmuxEscape(value)}"`);
}

function paneHasChildren(pid: string): boolean {
	return Boolean(pid) && Boolean(tryRun(`pgrep -P ${pid}`));
}

interface PaneQuiescenceOptions {
	pollMs?: number;
	quietWindowMs?: number;
	timeoutMs?: number;
}

function parseManagedPaneLine(line: string, ownerSession: string): ManagedPaneInfo | null {
	const parts = line.split("\t");
	const paneId = parts[0] ?? "";
	const session = parts[1] ?? "";
	const windowIndex = Number.parseInt(parts[2] ?? "", 10);
	const paneIndex = Number.parseInt(parts[3] ?? "", 10);
	const active = (parts[4] ?? "") === "1";
	const currentCommand = parts[5] ?? "";
	const panePid = parts[6] ?? "";
	const managed = parts[7] ?? "";
	const paneOwnerSession = parts[8] ?? "";
	const title = parts[9] ?? "";
	if (managed !== MANAGED_PANE_MARK || paneOwnerSession !== ownerSession) return null;
	if (!paneId || !session || Number.isNaN(windowIndex) || Number.isNaN(paneIndex)) return null;
	return {
		paneId,
		ownerSession: paneOwnerSession,
		title: title || paneId,
		session,
		windowIndex,
		paneIndex,
		active,
		visible: session === ownerSession && windowIndex === 0 && paneIndex === 1,
		currentCommand,
		idle: isIdleShellCommand(currentCommand) && !paneHasChildren(panePid),
	};
}

async function getPaneQuiescenceSignature(paneId: string): Promise<string | null> {
	const raw = tryRun(`tmux display -p -t ${paneId} "#{pane_current_command}\t#{cursor_x}\t#{cursor_y}"`);
	if (!raw) return null;
	const parts = raw.split("\t");
	const currentCommand = parts[0] ?? "";
	const cursorX = Number.parseInt(parts[1] ?? "", 10);
	const cursorY = Number.parseInt(parts[2] ?? "", 10);
	if (!isIdleShellCommand(currentCommand) || Number.isNaN(cursorX) || Number.isNaN(cursorY) || (cursorX === 0 && cursorY === 0)) {
		return null;
	}

	const captured = tryRun(`tmux capture-pane -t ${paneId} -p -S -5`) ?? "";
	const tail = captured
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.trim().length > 0)
		.slice(-3)
		.join("\n");
	if (!tail) return null;
	return `${currentCommand}\n${cursorX},${cursorY}\n${tail}`;
}

/** Wait for a reused pane shell to become visually quiescent after respawn. */
export async function waitForPaneQuiescence(paneId: string, options: PaneQuiescenceOptions = {}): Promise<boolean> {
	const pollMs = options.pollMs ?? 20;
	const quietWindowMs = options.quietWindowMs ?? 140;
	const timeoutMs = options.timeoutMs ?? 300;
	const deadline = Date.now() + timeoutMs;
	let lastSignature: string | null = null;
	let stableSince = 0;

	while (Date.now() < deadline) {
		const signature = await getPaneQuiescenceSignature(paneId);
		if (signature && signature === lastSignature) {
			if (stableSince === 0) {
				stableSince = Date.now();
			} else if (Date.now() - stableSince >= quietWindowMs) {
				return true;
			}
		} else {
			lastSignature = signature;
			stableSince = 0;
		}
		await delay(pollMs);
	}

	return false;
}

/** Escape a string for safe embedding inside a tmux send-keys double-quoted argument. */
export function tmuxEscape(s: string): string {
	return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$");
}
