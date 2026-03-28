/**
 * Command lifecycle tracking via pane_current_command polling.
 *
 * Sends raw commands to tmux via send-keys. A non-blocking setInterval
 * polls tmux's pane_current_command format (~5ms per call) to detect
 * when the foreground process returns to the shell. On completion,
 * captures pane output and dispatches a notification into the conversation.
 *
 * Zero wrapper scripts. Zero temp files. Zero terminal pollution.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CompletionDelivery, SilenceConfig } from "./types.js";
import { run, tryRun, listWindows, captureOutput, tmuxEscape } from "./session.js";

const IDLE_SHELLS = new Set(["bash", "zsh", "sh", "fish", "dash", "ksh", "tcsh", "csh"]);
const POLL_INTERVAL_MS = 2000;

// ---------------------------------------------------------------------------
// Completion tracking
// ---------------------------------------------------------------------------

interface CompletionTracker {
	timer: ReturnType<typeof setInterval>;
	session: string;
	windowIndex: number;
	/** The foreground command seen at launch (used to detect transition back to shell). */
	initialCommand: string | null;
}

const completionTrackers = new Map<string, CompletionTracker>();

function trackerKey(session: string, windowIndex: number): string {
	return `${session}:${windowIndex}`;
}

function filterPaneOutput(raw: string, maxLines = 20): string {
	return raw
		.split("\n")
		.filter((l) => l.trim())
		.slice(-maxLines)
		.join("\n");
}

/**
 * Start polling a window for command completion.
 * Non-blocking — returns immediately. The interval fires every POLL_INTERVAL_MS
 * on the Node event loop and dispatches a message when the foreground process
 * transitions back to an idle shell.
 *
 * @param deliverAs Controls when the notification reaches the agent:
 *   - "steer": interrupts the current turn immediately
 *   - "followUp": waits for the current turn to finish, then triggers a new turn
 *   - "nextTurn": queues silently until the next user message
 */
export function trackCompletion(pi: ExtensionAPI, session: string, windowIndex: number, deliverAs: CompletionDelivery = "followUp", triggerTurn = true): void {
	const key = trackerKey(session, windowIndex);

	// Cancel any existing tracker for this window (new command supersedes)
	const existing = completionTrackers.get(key);
	if (existing) clearInterval(existing.timer);

	// Snapshot what's running right now (might still be the shell if send-keys
	// hasn't been processed yet — we handle that with a startup grace period).
	const currentCmd = tryRun(`tmux display -p -t ${session}:${windowIndex} "#{pane_current_command}"`);
	let seenNonShell = !IDLE_SHELLS.has(currentCmd ?? "");
	let ticks = 0;

	const timer = setInterval(() => {
		ticks++;
		const cmd = tryRun(`tmux display -p -t ${session}:${windowIndex} "#{pane_current_command}"`);

		// Window or session gone — clean up silently
		if (cmd === null) {
			clearInterval(timer);
			completionTrackers.delete(key);
			clearSilenceForWindow(session, windowIndex);
			return;
		}

		// Track if we've ever seen a non-shell command (the actual command running)
		if (!IDLE_SHELLS.has(cmd)) {
			seenNonShell = true;
			return; // still running
		}

		// We see a shell. If we never saw the command start, give it a grace
		// period (send-keys may not have been processed yet).
		if (!seenNonShell) {
			// Grace: up to 5 ticks (10s) to see the command start
			if (ticks < 5) return;
			// If after 10s it's still shell, the command was instant (e.g. echo)
		}

		// Command finished — stop polling
		clearInterval(timer);
		completionTrackers.delete(key);
		clearSilenceForWindow(session, windowIndex);

		// Capture output and notify
		const windows = listWindows(session);
		const windowTitle = windows.find((w) => w.index === windowIndex)?.title ?? `window ${windowIndex}`;
		const output = captureOutput(session, windowIndex);
		const trimmed = filterPaneOutput(output);

		pi.sendMessage(
			{
				customType: "tmux-completion",
				content: `tmux "${windowTitle}" (:${windowIndex}) finished.\n\n\`\`\`\n${trimmed}\n\`\`\``,
				display: true,
			},
			{ triggerTurn, deliverAs },
		);
	}, POLL_INTERVAL_MS);

	completionTrackers.set(key, {
		timer,
		session,
		windowIndex,
		initialCommand: currentCmd,
	});
}

// ---------------------------------------------------------------------------
// Silence tracking (unchanged — uses tmux's monitor-silence, already invisible)
// ---------------------------------------------------------------------------

interface SilenceTracker {
	currentInterval: number;
	factor: number;
	ceiling: number;
}

const silenceTrackers = new Map<string, SilenceTracker>();

function silenceKey(session: string, windowIndex: number): string {
	return `${session}:${windowIndex}`;
}

export function registerSilence(session: string, windowIndex: number, config: SilenceConfig): void {
	const key = silenceKey(session, windowIndex);
	silenceTrackers.set(key, {
		currentInterval: config.timeout,
		factor: config.factor,
		ceiling: config.cap,
	});
	wireSilence(session, windowIndex, config);
}

export function clearSilenceForWindow(session: string, windowIndex: number): boolean {
	const key = silenceKey(session, windowIndex);
	const had = silenceTrackers.delete(key);
	tryRun(`tmux set-option -w -t ${session}:${windowIndex} monitor-silence 0`);
	tryRun(`tmux set-hook -uw -t ${session}:${windowIndex} alert-silence`);
	return had;
}

/**
 * Check for silence alerts. Called from the same poll loop or on demand.
 * tmux's monitor-silence + alert-silence hook writes to a tmux env var
 * which we read during the poll cycle.
 */
export function checkSilence(pi: ExtensionAPI, session: string, windowIndex: number): void {
	const key = silenceKey(session, windowIndex);
	const tracker = silenceTrackers.get(key);
	if (!tracker) return;

	// Check if tmux fired a silence alert via environment variable
	const flag = tryRun(`tmux show-environment -t ${session} PI_SILENCE_${windowIndex} 2>/dev/null`);
	if (!flag || !flag.includes("=1")) return;

	// Clear the flag
	tryRun(`tmux set-environment -t ${session} -u PI_SILENCE_${windowIndex}`);

	const windows = listWindows(session);
	const windowTitle = windows.find((w) => w.index === windowIndex)?.title ?? `window ${windowIndex}`;
	const output = captureOutput(session, windowIndex);
	const trimmed = filterPaneOutput(output);

	pi.sendMessage(
		{
			customType: "tmux-silence",
			content: `tmux "${windowTitle}" (:${windowIndex}) silent for ${tracker.currentInterval}s — may need input. Use "mute" action with window ${windowIndex} to suppress.\n\n\`\`\`\n${trimmed}\n\`\`\``,
			display: true,
		},
		{ triggerTurn: true, deliverAs: "followUp" },
	);

	// Backoff
	const nextInterval = Math.min(Math.round(tracker.currentInterval * tracker.factor), tracker.ceiling);
	tracker.currentInterval = nextInterval;
	tryRun(`tmux set-option -w -t ${session}:${windowIndex} monitor-silence ${nextInterval}`);
}

// ---------------------------------------------------------------------------
// Command execution — clean send-keys, no wrappers
// ---------------------------------------------------------------------------

/**
 * Send a command to an existing pane via send-keys.
 * Just the command, nothing else. History stays clean.
 */
export function sendCommandToPane(paneTarget: string, command: string): void {
	// Exit copy mode if active (no-op error if not in copy mode — tryRun swallows it)
	tryRun(`tmux send-keys -t ${paneTarget} -X cancel`);
	// Clear any partial input on the command line
	tryRun(`tmux send-keys -t ${paneTarget} C-u`);
	run(`tmux send-keys -t ${paneTarget} "${tmuxEscape(command)}" C-m`);
}

/** Send a command to a window by targeting its active pane. */
export function sendCommand(session: string, windowIndex: number, command: string): void {
	sendCommandToPane(`${session}:${windowIndex}`, command);
}

/**
 * Create a new tmux window and send the command to it.
 * Returns the window index.
 */
export function createWindowWithCommand(
	session: string,
	cwd: string,
	command: string,
	windowName: string,
): number {
	const name = windowName.slice(0, 30);
	const raw = run(`tmux new-window -t ${session} -n "${tmuxEscape(name)}" -c "${cwd}" -P -F "#{window_index}"`);
	const index = parseInt(raw, 10);
	sendCommand(session, index, command);
	return index;
}

/**
 * Track completion by watching a specific pane ID (tmux mode).
 */
export function trackCompletionByPane(
	pi: ExtensionAPI,
	session: string,
	paneId: string,
	label: string,
	deliverAs: CompletionDelivery = "followUp",
	triggerTurn = true,
): void {
	const key = `pane:${paneId}`;
	const existing = completionTrackers.get(key);
	if (existing) clearInterval(existing.timer);

	const currentCmd = tryRun(`tmux display -p -t ${paneId} "#{pane_current_command}"`);
	let seenNonShell = !IDLE_SHELLS.has(currentCmd ?? "");
	let ticks = 0;

	const timer = setInterval(() => {
		ticks++;
		const cmd = tryRun(`tmux display -p -t ${paneId} "#{pane_current_command}"`);

		if (cmd === null) {
			clearInterval(timer);
			completionTrackers.delete(key);
			return;
		}
		if (!IDLE_SHELLS.has(cmd)) { seenNonShell = true; return; }
		if (!seenNonShell && ticks < 5) return;

		clearInterval(timer);
		completionTrackers.delete(key);

		const raw = tryRun(`tmux capture-pane -t ${paneId} -p -J`) ?? "";
		const trimmed = filterPaneOutput(raw);

		pi.sendMessage(
			{
				customType: "tmux-completion",
				content: `tmux "${label}" finished.\n\n\`\`\`\n${trimmed}\n\`\`\``,
				display: true,
			},
			{ triggerTurn, deliverAs },
		);
	}, POLL_INTERVAL_MS);

	completionTrackers.set(key, { timer, session, windowIndex: -1, initialCommand: currentCmd });
}

/**
 * Send a command in window 0 of a freshly created session.
 */
export function startCommandInFirstWindow(
	session: string,
	windowName: string,
	command: string,
): void {
	run(`tmux rename-window -t ${session}:0 "${tmuxEscape(windowName)}"`);
	sendCommand(session, 0, command);
}

// ---------------------------------------------------------------------------
// Silence wiring (tmux hooks — invisible to user)
// ---------------------------------------------------------------------------

function wireSilence(session: string, windowIndex: number, config: SilenceConfig): void {
	if (config.timeout <= 0) return;
	run(`tmux set-option -w -t ${session}:${windowIndex} monitor-silence ${config.timeout}`);
	// Hook sets an env var that we check during polling — no files needed
	const alertHook = `set-environment -t ${session} PI_SILENCE_${windowIndex} 1`;
	run(`tmux set-hook -w -t ${session}:${windowIndex} alert-silence "${tmuxEscape(alertHook)}"`);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Stop all trackers. Call on session shutdown. */
export function stopAll(): void {
	for (const tracker of completionTrackers.values()) {
		clearInterval(tracker.timer);
	}
	completionTrackers.clear();
	silenceTrackers.clear();
}
