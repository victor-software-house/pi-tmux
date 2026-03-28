/**
 * tmux session primitives — process execution, project root resolution,
 * session identity, and window introspection.
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { WindowInfo } from "./types.js";

/** Run a shell command synchronously, returning trimmed stdout. Throws on failure. */
export function run(cmd: string): string {
	return execSync(cmd, { encoding: "utf-8", timeout: 10_000 }).trim();
}

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

/** Check whether a tmux session with the given name is alive. */
export function isSessionAlive(name: string): boolean {
	return tryRun(`tmux has-session -t ${name} 2>/dev/null && echo ok`) === "ok";
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
// Tmux mode: staging session + view pane
// ---------------------------------------------------------------------------

/** Staging session name — command windows created here, no CC involvement, no flash. */
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
	const panes = tryRun(`tmux list-panes -t ${session}:0 -F "#{pane_index} #{pane_id}"`);
	const existing = panes?.split("\n").find((l) => l.startsWith("1 "));
	if (existing) return existing.split(" ")[1] ?? "";
	const flag = layout === "split-horizontal" ? "-v" : "-h";
	const raw = run(`tmux split-window ${flag} -t ${session}:0 -c "${cwd}" -d -P -F "#{pane_id}"`);
	return raw.trim();
}

/**
 * Create a new window in the staging session. Returns window index.
 * No CC involvement — no tab flash.
 */
export function createStagingWindow(staging: string, cwd: string, name: string): number {
	const safeName = name.slice(0, 30);
	run(`tmux new-window -d -t ${staging} -n "${tmuxEscape(safeName)}" -c "${cwd}"`);
	// Get the index of the window we just created (last window by index)
	const raw = tryRun(`tmux list-windows -t ${staging} -F "#{window_index}\t#{window_name}"`);
	if (!raw) return 0;
	for (const line of raw.split("\n").reverse()) {
		const parts = line.split("\t");
		if (parts[1] === safeName) return parseInt(parts[0] ?? "0", 10);
	}
	return 0;
}

/**
 * Swap the CC view pane with a staging window pane.
 * Atomic — no new window created, no tab flash, no layout change.
 */
export function swapViewPane(session: string, staging: string, stagingIdx: number): void {
	run(`tmux swap-pane -d -s ${session}:0.1 -t ${staging}:${stagingIdx}.0`);
}

/**
 * Respawn an idle staging window with a fresh shell (no new window creation).
 */
export function respawnStagingWindow(staging: string, windowIdx: number, cwd: string): void {
	run(`tmux respawn-pane -k -t ${staging}:${windowIdx}.0 -c "${cwd}"`);
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
	const raw = tryRun(`tmux list-windows -t ${sessionName} -F "#{window_index}\t#{window_name}\t#{window_active}"`);
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
		return tryRun(`tmux capture-pane -t ${sessionName}:${target} -p -S -50`) ?? "(no output)";
	}
	const windows = listWindows(sessionName);
	if (windows.length === 0) return "(no windows)";
	return windows
		.map((w) => {
			const paneOutput = tryRun(`tmux capture-pane -t ${sessionName}:${w.index} -p -S -50`) ?? "(no output)";
			return `-- window ${w.index}: ${w.title} --\n${paneOutput}`;
		})
		.join("\n\n");
}

/**
 * Check whether a tmux window is idle — shell at prompt with no running child processes.
 * Uses the same logic as /tmux:clear.
 */
export function isWindowIdle(sessionName: string, windowIndex: number): boolean {
	const idleShells = new Set(["bash", "zsh", "sh", "fish", "dash"]);
	const raw = tryRun(
		`tmux list-windows -t ${sessionName} -F "#{window_index}\t#{pane_current_command}\t#{pane_pid}"`,
	);
	if (!raw) return false;
	for (const line of raw.split("\n")) {
		const parts = line.split("\t");
		const idx = parseInt(parts[0] ?? "", 10);
		if (idx !== windowIndex) continue;
		const cmd = parts[1] ?? "";
		const pid = parts[2] ?? "";
		if (!idleShells.has(cmd)) return false;
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

/** Escape a string for safe embedding inside a tmux send-keys double-quoted argument. */
export function tmuxEscape(s: string): string {
	return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$");
}
