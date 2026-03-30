/**
 * Command lifecycle tracking and silence monitoring.
 *
 * Completion tracking: polls tmux's pane_current_command via pane ID to detect
 * when the foreground process returns to the shell. On completion, captures
 * pane output and dispatches a notification into the conversation.
 *
 * Silence tracking: uses tmux's monitor-silence + alert-silence hooks to detect
 * commands waiting for input, with configurable exponential backoff.
 *
 * All tracking is pane-ID-based (tmux mode only). Legacy window-index-based
 * tracking has been removed.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CompletionDelivery, SilenceConfig } from "./types.js";
import { run, tryRun, tmuxEscape, tmuxSessionTarget } from "./session.js";

const IDLE_SHELLS = new Set(["bash", "zsh", "sh", "fish", "dash", "ksh", "tcsh", "csh"]);

// ---------------------------------------------------------------------------
// Completion tracking
// ---------------------------------------------------------------------------

interface CompletionTracker {
	timer: ReturnType<typeof setInterval>;
	session: string;
	initialCommand: string | null;
}

const completionTrackers = new Map<string, CompletionTracker>();

const COMPLETION_SHOW_LINES = 20;

interface CapturedOutput {
	/** All non-empty lines in the scrollback. */
	totalLines: number;
	/** The last N lines shown in the excerpt. */
	shownLines: number;
	/** The excerpt text. */
	excerpt: string;
}

/**
 * Capture full scrollback from a pane and return a structured excerpt.
 * Uses `capture-pane -S -` to get all available scrollback, then takes
 * the last `maxLines` non-empty lines.
 */
function captureFullOutput(paneId: string, maxLines = COMPLETION_SHOW_LINES): CapturedOutput {
	const raw = tryRun(`tmux capture-pane -t ${paneId} -p -J -S -`) ?? "";
	const allLines = raw.split("\n").filter((l) => l.trim());
	const totalLines = allLines.length;
	const shown = allLines.slice(-maxLines);
	return {
		totalLines,
		shownLines: shown.length,
		excerpt: shown.join("\n"),
	};
}

/**
 * Track completion by watching a specific pane ID.
 *
 * Non-blocking — returns immediately. The interval fires on the Node event loop
 * at the configured poll interval and dispatches a message when the foreground
 * process transitions back to an idle shell.
 *
 * @param deliverAs Controls when the notification reaches the agent:
 *   - "steer": interrupts the current turn immediately
 *   - "followUp": waits for the current turn to finish, then triggers a new turn
 *   - "nextTurn": queues silently until the next user message
 */
export function trackCompletionByPane(
	pi: ExtensionAPI,
	session: string,
	paneId: string,
	label: string,
	deliverAs: CompletionDelivery = "followUp",
	triggerTurn = true,
	pollIntervalMs = 250,
): void {
	const key = `pane:${paneId}`;
	const existing = completionTrackers.get(key);
	if (existing) clearInterval(existing.timer);

	const currentCmd = tryRun(`tmux display -p -t ${paneId} "#{pane_current_command}"`);
	let seenNonShell = !IDLE_SHELLS.has(currentCmd ?? "");
	const startTime = Date.now();
	const maxPollMs = 300_000; // 5 minutes max before giving up

	const timer = setInterval(() => {
		// Safety: stop polling after max duration
		if (Date.now() - startTime > maxPollMs) {
			clearInterval(timer);
			completionTrackers.delete(key);
			return;
		}

		const cmd = tryRun(`tmux display -p -t ${paneId} "#{pane_current_command}"`);

		if (cmd === null) {
			clearInterval(timer);
			completionTrackers.delete(key);
			return;
		}
		if (!IDLE_SHELLS.has(cmd)) { seenNonShell = true; return; }
		// Only fire completion when we saw a non-shell command start and then
		// return to the shell. This prevents false completion for shell builtins
		// like `read` or `wait` where pane_current_command stays as the shell name.
		if (!seenNonShell) return;

		clearInterval(timer);
		completionTrackers.delete(key);

		const output = captureFullOutput(paneId);
		const omitted = output.totalLines - output.shownLines;
		const meta = omitted > 0
			? ` (${output.totalLines} lines total, showing last ${output.shownLines})`
			: "";

		pi.sendMessage(
			{
				customType: "tmux-completion",
				content: `tmux "${label}" finished.${meta}\n\n\`\`\`\n${output.excerpt}\n\`\`\``,
				display: true,
			},
			{ triggerTurn, deliverAs },
		);
	}, pollIntervalMs);

	completionTrackers.set(key, { timer, session, initialCommand: currentCmd });
}

// ---------------------------------------------------------------------------
// Silence tracking
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
	tryRun(`tmux set-option -w -t ${tmuxSessionTarget(session)}:${windowIndex} monitor-silence 0`);
	tryRun(`tmux set-hook -uw -t ${tmuxSessionTarget(session)}:${windowIndex} alert-silence`);
	return had;
}

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

/**
 * Send a command to an existing pane via send-keys.
 *
 * Prepends a focus-reporting disable sequence so that iTerm2 CC
 * stops sending ^[[I/^[[O to the pane.  This must happen after
 * the shell has finished initialization (which re-enables focus
 * reporting), so it is sent as an inline prefix to the command.
 */
export function sendCommandToPane(paneTarget: string, command: string): void {
	tryRun(`tmux send-keys -t ${paneTarget} -X cancel 2>/dev/null`);
	tryRun(`tmux send-keys -t ${paneTarget} C-u`);
	const wrapped = `printf '\\e[?1004l'; ${command}`;
	run(`tmux send-keys -t ${paneTarget} "${tmuxEscape(wrapped)}" C-m`);
}

/** Send C-c to interrupt a running command in a pane. */
export function sendInterrupt(paneTarget: string): void {
	tryRun(`tmux send-keys -t ${paneTarget} C-c`);
}

// ---------------------------------------------------------------------------
// Silence wiring
// ---------------------------------------------------------------------------

function wireSilence(session: string, windowIndex: number, config: SilenceConfig): void {
	if (config.timeout <= 0) return;
	run(`tmux set-option -w -t ${tmuxSessionTarget(session)}:${windowIndex} monitor-silence ${config.timeout}`);
	const alertHook = `set-environment -t ${tmuxSessionTarget(session)} PI_SILENCE_${windowIndex} 1`;
	run(`tmux set-hook -w -t ${tmuxSessionTarget(session)}:${windowIndex} alert-silence "${tmuxEscape(alertHook)}"`);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Stop the completion tracker for a specific pane. Returns true if a tracker was stopped. */
export function stopCompletionTracking(paneId: string): boolean {
	const key = `pane:${paneId}`;
	const tracker = completionTrackers.get(key);
	if (!tracker) return false;
	clearInterval(tracker.timer);
	completionTrackers.delete(key);
	return true;
}

/** Stop all trackers. Call on session shutdown. */
export function stopAll(): void {
	for (const tracker of completionTrackers.values()) {
		clearInterval(tracker.timer);
	}
	completionTrackers.clear();
	silenceTrackers.clear();
}
