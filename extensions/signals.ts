/**
 * Command lifecycle tracking via signal files.
 *
 * Each command gets a wrapper script that writes an exit code to a signal file
 * on completion. A chokidar watcher detects new signal files and dispatches
 * completion or silence notifications back into the conversation.
 *
 * Signal file naming: `<session>.<windowIdx>.<runId>` for completions,
 * `silence.<session>.<windowIdx>.<runId>` for silence alerts.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { watch as chokidarWatch, type FSWatcher } from "chokidar";
import type { SilenceConfig } from "./types.js";
import { run, tryRun, listWindows, tmuxEscape } from "./session.js";

const SIGNAL_ROOT = "/tmp/pi-tmux";

let signalDir: string | null = null;
let watcher: FSWatcher | null = null;

/**
 * Per-window silence backoff tracker.
 * Key format: `session.windowIndex.runId`
 */
const silenceTracker = new Map<string, { currentInterval: number; factor: number; ceiling: number }>();

// ---------------------------------------------------------------------------
// Signal directory
// ---------------------------------------------------------------------------

export function getSignalDir(): string {
	if (!signalDir) {
		signalDir = join(SIGNAL_ROOT, randomBytes(8).toString("hex"));
		mkdirSync(signalDir, { recursive: true });
	}
	return signalDir;
}

export function initSignalDir(sessionId: string | null | undefined): void {
	const suffix = sessionId
		? Buffer.from(sessionId).toString("base64url").slice(0, 16)
		: randomBytes(8).toString("hex");
	signalDir = join(SIGNAL_ROOT, suffix);
	mkdirSync(signalDir, { recursive: true });
}

// ---------------------------------------------------------------------------
// Signal file parsing
// ---------------------------------------------------------------------------

interface SignalIdentity {
	session: string;
	windowIndex: number;
	runId: string;
}

function parseSignalName(name: string): SignalIdentity | null {
	// Format: session.windowIndex.runId
	const segments = name.split(".");
	if (segments.length < 3) return null;
	const runId = segments.pop()!;
	const winStr = segments.pop()!;
	const windowIndex = parseInt(winStr, 10);
	if (Number.isNaN(windowIndex)) return null;
	const session = segments.join(".");
	if (!session) return null;
	return { session, windowIndex, runId };
}

function buildTrackerKey(id: SignalIdentity): string {
	return `${id.session}.${id.windowIndex}.${id.runId}`;
}

// ---------------------------------------------------------------------------
// Silence tracking
// ---------------------------------------------------------------------------

export function registerSilence(session: string, windowIndex: number, runId: string, config: SilenceConfig): void {
	silenceTracker.set(buildTrackerKey({ session, windowIndex, runId }), {
		currentInterval: config.timeout,
		factor: config.factor,
		ceiling: config.cap,
	});
}

export function clearSilenceForWindow(session: string, windowIndex: number): boolean {
	let cleared = false;
	for (const key of silenceTracker.keys()) {
		const id = parseSignalName(key);
		if (id && id.session === session && id.windowIndex === windowIndex) {
			silenceTracker.delete(key);
			cleared = true;
		}
	}
	tryRun(`tmux set-option -w -t ${session}:${windowIndex} monitor-silence 0`);
	tryRun(`tmux set-hook -uw -t ${session}:${windowIndex} alert-silence`);
	return cleared;
}

// ---------------------------------------------------------------------------
// Notification dispatchers
// ---------------------------------------------------------------------------

function filterPaneOutput(raw: string | null, maxLines = 20): string {
	return (raw ?? "")
		.split("\n")
		.filter((l) => l.trim())
		.slice(-maxLines)
		.join("\n");
}

function dispatchCompletion(pi: ExtensionAPI, filepath: string, name: string): void {
	const rawCode = readFileSync(filepath, "utf-8").trim();
	unlinkSync(filepath);

	const id = parseSignalName(name);
	if (!id) return;

	// Clean up silence tracking for this run
	const key = buildTrackerKey(id);
	if (silenceTracker.has(key)) {
		silenceTracker.delete(key);
		tryRun(`tmux set-option -w -t ${id.session}:${id.windowIndex} monitor-silence 0`);
		tryRun(`tmux set-hook -uw -t ${id.session}:${id.windowIndex} alert-silence`);
	}

	const windows = listWindows(id.session);
	const windowTitle = windows.find((w) => w.index === id.windowIndex)?.title ?? `window ${id.windowIndex}`;

	const recentOutput = tryRun(`tmux capture-pane -t ${id.session}:${id.windowIndex} -p -S -30`);
	const trimmed = filterPaneOutput(recentOutput);

	const exitCode = parseInt(rawCode, 10);
	const outcome = exitCode === 0 ? "completed successfully" : `failed with exit code ${exitCode}`;

	pi.sendMessage(
		{
			customType: "tmux-completion",
			content: `tmux window "${windowTitle}" (:${id.windowIndex}) ${outcome}.\n\n\`\`\`\n${trimmed}\n\`\`\``,
			display: true,
		},
		{ triggerTurn: true, deliverAs: "followUp" },
	);
}

function dispatchSilenceAlert(pi: ExtensionAPI, filepath: string, name: string): void {
	unlinkSync(filepath);

	const stripped = name.slice("silence.".length);
	const id = parseSignalName(stripped);
	if (!id) return;

	const key = buildTrackerKey(id);
	const tracker = silenceTracker.get(key);
	if (!tracker) return;

	const windows = listWindows(id.session);
	const windowTitle = windows.find((w) => w.index === id.windowIndex)?.title ?? `window ${id.windowIndex}`;

	const recentOutput = tryRun(`tmux capture-pane -t ${id.session}:${id.windowIndex} -p -S -30`);
	const trimmed = filterPaneOutput(recentOutput);

	pi.sendMessage(
		{
			customType: "tmux-silence",
			content: `tmux window "${windowTitle}" (:${id.windowIndex}) silent for ${tracker.currentInterval}s — may need input. Use "mute" action with window ${id.windowIndex} to suppress.\n\n\`\`\`\n${trimmed}\n\`\`\``,
			display: true,
		},
		{ triggerTurn: true, deliverAs: "followUp" },
	);

	// Apply backoff for next alert
	const nextInterval = Math.min(Math.round(tracker.currentInterval * tracker.factor), tracker.ceiling);
	tracker.currentInterval = nextInterval;
	tryRun(`tmux set-option -w -t ${id.session}:${id.windowIndex} monitor-silence ${nextInterval}`);
}

// ---------------------------------------------------------------------------
// File watcher
// ---------------------------------------------------------------------------

export function startWatching(pi: ExtensionAPI): void {
	if (watcher) return;

	const dir = getSignalDir();
	watcher = chokidarWatch(dir, {
		ignoreInitial: true,
		depth: 0,
		ignored: [join(dir, "scripts"), /\.sh$/],
		awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 60 },
	});

	watcher.on("add", (filepath) => {
		try {
			const fileName = filepath.split("/").pop();
			if (!fileName) return;
			if (fileName.startsWith("silence.")) {
				dispatchSilenceAlert(pi, filepath, fileName);
			} else {
				dispatchCompletion(pi, filepath, fileName);
			}
		} catch {
			// Racing deletes, permission errors — ignore
		}
	});
}

export async function stopWatching(): Promise<void> {
	if (watcher) {
		await watcher.close();
		watcher = null;
	}
	silenceTracker.clear();
	if (signalDir) {
		try {
			const { execSync } = await import("node:child_process");
			execSync(`rm -rf "${signalDir}"`, { timeout: 5_000 });
		} catch {
			// best effort
		}
	}
}

// ---------------------------------------------------------------------------
// Command execution with signal wiring
// ---------------------------------------------------------------------------

/** Escape single quotes for use inside a single-quoted shell string. */
function escapeSingleQuotes(s: string): string {
	return s.replace(/'/g, "'\\''");
}

/** The user's configured shell, falling back to sh. */
function userShell(): string {
	return process.env["SHELL"] ?? "sh";
}

/**
 * Build the tmux startup command for a pane.
 * Runs via the user's shell with -i so rc files are sourced and the full
 * environment is available. Non-interactive execution means zero terminal echo.
 * exec $SHELL at the end drops into an interactive shell for inspection.
 */
function buildStartupCommand(command: string, completionFile: string): string {
	const shell = userShell();
	const escaped = escapeSingleQuotes(command);
	const file = escapeSingleQuotes(completionFile);
	return `${shell} -i -c '${escaped}; _ec=$?; echo $_ec > '"'"'${file}'"'"'; exec ${shell}'`;
}

/**
 * Run a command in a tmux pane using respawn-pane (or new-window for new panes).
 * bash -c runs non-interactively — zero terminal echo.
 * exec $SHELL at the end keeps the window alive for inspection.
 * Works for both new windows and reused idle windows.
 */
export function runCommandInPane(
	dir: string,
	session: string,
	windowIndex: number,
	cwd: string,
	command: string,
	silence?: SilenceConfig,
): string {
	const runId = randomBytes(4).toString("hex");
	const completionFile = join(dir, `${session}.${windowIndex}.${runId}`);
	const startupCmd = buildStartupCommand(command, completionFile);

	run(`tmux respawn-pane -t ${session}:${windowIndex} -k -c "${cwd}" "${tmuxEscape(startupCmd)}"`);
	wireSilence(dir, session, windowIndex, runId, silence);
	return runId;
}

/**
 * Create a new tmux window and immediately start the command in it.
 * Passes the startup command directly to new-window — no intermediate shell.
 */
export function createWindowWithCommand(
	dir: string,
	session: string,
	cwd: string,
	command: string,
	windowName: string,
	silence?: SilenceConfig,
): { index: number; runId: string } {
	const runId = randomBytes(4).toString("hex");
	const name = windowName.slice(0, 30);

	// Create window first to get the index, then respawn with the real signal path
	const raw = run(`tmux new-window -t ${session} -n "${tmuxEscape(name)}" -c "${cwd}" -P -F "#{window_index}"`);
	const index = parseInt(raw, 10);

	const completionFile = join(dir, `${session}.${index}.${runId}`);
	const startupCmd = buildStartupCommand(command, completionFile);
	run(`tmux respawn-pane -t ${session}:${index} -k -c "${cwd}" "${tmuxEscape(startupCmd)}"`);

	wireSilence(dir, session, index, runId, silence);
	return { index, runId };
}

/**
 * Start a command in window 0 of a freshly created session.
 */
export function startCommandInFirstWindow(
	dir: string,
	session: string,
	windowName: string,
	cwd: string,
	command: string,
	silence?: SilenceConfig,
): string {
	run(`tmux rename-window -t ${session}:0 "${tmuxEscape(windowName)}"`);
	return runCommandInPane(dir, session, 0, cwd, command, silence);
}

function wireSilence(dir: string, session: string, windowIndex: number, runId: string, silence?: SilenceConfig): void {
	if (!silence || silence.timeout <= 0) return;
	const silenceFile = join(dir, `silence.${session}.${windowIndex}.${runId}`);
	run(`tmux set-option -w -t ${session}:${windowIndex} monitor-silence ${silence.timeout}`);
	const alertHook = `run-shell 'echo 1 > "${tmuxEscape(silenceFile)}"' ; kill-session -C -t ${session}`;
	run(`tmux set-hook -w -t ${session}:${windowIndex} alert-silence "${tmuxEscape(alertHook)}"`);
}
