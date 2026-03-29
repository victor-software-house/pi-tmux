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
	windowIndex: number;
	initialCommand: string | null;
}

const completionTrackers = new Map<string, CompletionTracker>();

function filterPaneOutput(raw: string, maxLines = 20): string {
	return raw
		.split("\n")
		.filter((l) => l.trim())
		.slice(-maxLines)
		.join("\n");
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
	}, pollIntervalMs);

	completionTrackers.set(key, { timer, session, windowIndex: -1, initialCommand: currentCmd });
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
 */
export function sendCommandToPane(paneTarget: string, command: string): void {
	tryRun(`tmux send-keys -t ${paneTarget} -X cancel 2>/dev/null`);
	tryRun(`tmux send-keys -t ${paneTarget} C-u`);
	run(`tmux send-keys -t ${paneTarget} "${tmuxEscape(command)}" C-m`);
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

/** Stop all trackers. Call on session shutdown. */
export function stopAll(): void {
	for (const tracker of completionTrackers.values()) {
		clearInterval(tracker.timer);
	}
	completionTrackers.clear();
	silenceTrackers.clear();
}
