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
const NAME_OPTION = "@pi_name";

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
 * Ensure view pane exists (pane 1 of the host window in the CC session).
 * This is the single pane alongside pi where command output is displayed.
 * Returns the pane ID.
 */
export function ensureViewPane(session: string, cwd: string, layout: string, hostWindowIndex = 0): string {
	const panes = tryRun(`tmux list-panes -t ${tmuxSessionTarget(session)}:${hostWindowIndex} -F "#{pane_index} #{pane_id}"`);
	const existing = panes?.split("\n").find((l) => l.startsWith("1 "));
	if (existing) return existing.split(" ")[1] ?? "";
	const flag = layout === "split-horizontal" ? "-v" : "-h";
	const raw = run(`tmux split-window ${flag} -t ${tmuxSessionTarget(session)}:${hostWindowIndex} -c "${cwd}" -d -P -F "#{pane_id}"`);
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
	let idx = 0;
	if (raw) {
		for (const line of raw.split("\n").reverse()) {
			const parts = line.split("\t");
			if (parts[1] === safeName) { idx = parseInt(parts[0] ?? "0", 10); break; }
		}
	}
	// Label the pane with its logical name — identity survives swap-pane
	const paneId = tryRun(`tmux display -p -t ${tmuxSessionTarget(staging)}:${idx}.0 "#{pane_id}"`);
	if (paneId) setPaneName(paneId.trim(), safeName);
	return idx;
}

/**
 * Swap a command pane into the view by pane ID.
 *
 * Uses `swap-pane` with `-d` so the view stays visible and focus stays on Pi.
 * A single swap is sufficient because pane identity is tracked by the `@pi_name`
 * pane option, not by which staging window a pane occupies. The displaced pane
 * ends up in whatever staging window the incoming pane came from — its `@pi_name`
 * label travels with it and remains correct regardless of position.
 */
export function swapViewPane(hostSession: string, paneId: string, hostWindowIndex = 0): void {
	const viewTarget = `${tmuxSessionTarget(hostSession)}:${hostWindowIndex}.1`;
	run(`tmux swap-pane -d -s ${viewTarget} -t ${paneId}`);
	// Disable focus event reporting by writing to the pane's tty (output side).
	// send-keys writes to stdin (the shell interprets it as input), but
	// \x1b[?1004l is a terminal escape that must go to stdout.
	const tty = tryRun(`tmux display-message -p -t ${viewTarget} "#{pane_tty}"`);
	if (tty) tryRun(`printf '\x1b[?1004l' > ${tty.trim()}`);
}

/**
 * Respawn an idle staging window with a fresh shell (no new window creation).
 */
export function respawnStagingWindow(staging: string, windowIdx: number, cwd: string, name: string): void {
	run(`tmux respawn-pane -k -t ${tmuxSessionTarget(staging)}:${windowIdx}.0 -c "${cwd}"`);
	// Re-label the new pane with its logical name (respawn creates a new pane ID)
	const paneId = tryRun(`tmux display -p -t ${tmuxSessionTarget(staging)}:${windowIdx}.0 "#{pane_id}"`);
	if (paneId) setPaneName(paneId.trim(), name);
}

/** Label a pane with its logical name. Survives swap-pane. */
function setPaneName(paneId: string, name: string): void {
	run(`tmux set-option -p -t ${paneId} ${NAME_OPTION} "${tmuxEscape(name)}"`);
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

function getViewPaneInfo(hostSession: string, hostWindowIndex = 0): { paneId: string; currentCommand: string; panePid: string } | null {
	const raw = tryRun(`tmux list-panes -t ${tmuxSessionTarget(hostSession)}:${hostWindowIndex} -F "#{pane_index}\t#{pane_id}\t#{pane_current_command}\t#{pane_pid}"`);
	if (!raw) return null;
	for (const line of raw.split("\n")) {
		const parts = line.split("\t");
		if ((parts[0] ?? "") !== "1") continue;
		const paneId = parts[1] ?? "";
		if (!paneId) return null;
		return {
			paneId,
			currentCommand: parts[2] ?? "",
			panePid: parts[3] ?? "",
		};
	}
	return null;
}

/** Read the @pi_name label from a pane. Returns null if unset. */
function readPaneName(paneId: string): string | null {
	const raw = tryRun(`tmux display -p -t ${paneId} "#{${NAME_OPTION}}"`);
	if (!raw || !raw.trim()) return null;
	return raw.trim();
}

/**
 * List all managed panes for a project session.
 *
 * Identity is the `@pi_name` pane option, which survives `swap-pane`.
 * Scans both the staging session panes and the view pane in the host session.
 * Panes without `@pi_name` (orphaned shells from swaps) are excluded.
 */
export function listManagedPanes(ownerSession: string, hostSession = ownerSession, hostWindowIndex = 0): ManagedPaneInfo[] {
	const staging = deriveStagingName(ownerSession);
	if (!isSessionAlive(staging)) return [];

	const panes: ManagedPaneInfo[] = [];

	// Check view pane (pane index 1 in host window) for @pi_name
	const viewPane = getViewPaneInfo(hostSession, hostWindowIndex);
	if (viewPane) {
		const name = readPaneName(viewPane.paneId);
		if (name) {
			panes.push({
				paneId: viewPane.paneId,
				ownerSession,
				title: name,
				session: hostSession,
				windowIndex: hostWindowIndex,
				paneIndex: 1,
				active: true,
				visible: true,
				currentCommand: viewPane.currentCommand,
				idle: isIdleShellCommand(viewPane.currentCommand) && !paneHasChildren(viewPane.panePid),
			});
		}
	}

	// Scan staging session panes for @pi_name
	const raw = tryRun(
		`tmux list-panes -s -t ${tmuxSessionTarget(staging)} -F "#{window_index}\t#{pane_id}\t#{pane_current_command}\t#{pane_pid}\t#{${NAME_OPTION}}"`,
	);
	if (raw) {
		for (const line of raw.split("\n")) {
			const parts = line.split("\t");
			const windowIndex = Number.parseInt(parts[0] ?? "", 10);
			const paneId = parts[1] ?? "";
			const currentCommand = parts[2] ?? "";
			const panePid = parts[3] ?? "";
			const name = parts[4] ?? "";
			if (Number.isNaN(windowIndex) || !paneId || !name) continue;

			panes.push({
				paneId,
				ownerSession,
				title: name,
				session: staging,
				windowIndex,
				paneIndex: 0,
				active: false,
				visible: false,
				currentCommand,
				idle: isIdleShellCommand(currentCommand) && !paneHasChildren(panePid),
			});
		}
	}

	panes.sort((a, b) => {
		if (a.visible !== b.visible) return a.visible ? -1 : 1;
		return a.windowIndex - b.windowIndex;
	});

	return panes;
}

/** Find one managed pane by staging window index, logical title, or current pane ID. */
export function resolveManagedPane(ownerSession: string, target: number | string, hostSession = ownerSession, hostWindowIndex = 0): ManagedPaneInfo | undefined {
	const panes = listManagedPanes(ownerSession, hostSession, hostWindowIndex);
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

function paneHasChildren(pid: string): boolean {
	return Boolean(pid) && Boolean(tryRun(`pgrep -P ${pid}`));
}

interface PaneQuiescenceOptions {
	pollMs?: number;
	quietWindowMs?: number;
	timeoutMs?: number;
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
