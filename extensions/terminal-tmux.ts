/**
 * Terminal attach — tmux CC mode implementation.
 *
 * In CC mode, tmux split-window / new-window create visible iTerm2
 * panes and tabs. The view pane (pane 1 of the host window) is created
 * by ensureViewPane() in session.ts via split-window.
 *
 * Exports: hasAttachedPane, closeAttachedSessions, openTerminal,
 * checkTmuxEnvironment.
 */
import type { AttachLayout } from "./types.js";
import { tryRun, tmuxSessionTarget } from "./session.js";

// Track the view pane ID so we know if we already have one.
let viewPaneId: string | null = null;

function findViewPaneId(tmuxSession: string, windowIndex = 0): string | null {
	const panes = tryRun(`tmux list-panes -t ${tmuxSessionTarget(tmuxSession)}:${windowIndex} -F "#{pane_index}\t#{pane_id}"`);
	if (!panes) return null;
	const existing = panes.split("\n").find((line) => line.startsWith("1\t"));
	if (!existing) return null;
	return existing.split("\t")[1] ?? null;
}

export function hasAttachedPane(tmuxSession: string, windowIndex = 0): boolean {
	viewPaneId = findViewPaneId(tmuxSession, windowIndex);
	return viewPaneId !== null;
}

export function closeAttachedSessions(tmuxSession: string, windowIndex = 0): void {
	const paneId = viewPaneId ?? findViewPaneId(tmuxSession, windowIndex);
	if (!paneId) return;
	tryRun(`tmux kill-pane -t ${paneId}`);
	viewPaneId = null;
}

export function openTerminal(session: string, mode: AttachLayout, _tmuxWindow?: number, hostWindowIndex = 0): string {
	const isSplit = mode === "split-vertical" || mode === "split-horizontal";

	if (isSplit) {
		const existingPaneId = findViewPaneId(session, hostWindowIndex);
		if (existingPaneId) {
			viewPaneId = existingPaneId;
			return "View pane already visible.";
		}

		const flag = mode === "split-vertical" ? "-h" : "-v";
		const raw = tryRun(`tmux split-window ${flag} -t ${tmuxSessionTarget(session)}:${hostWindowIndex} -d -P -F "#{pane_id}"`);
		if (!raw) return "Failed to create split pane.";
		viewPaneId = raw.trim();
		return `Opened ${mode.replace("split-", "")} split (${viewPaneId}).`;
	}

	// Tab mode — new window in the CC session
	const raw = tryRun(`tmux new-window -d -t ${tmuxSessionTarget(session)}: -P -F "#{pane_id}"`);
	if (!raw) return "Failed to create tab.";
	return `Opened new tab (${raw.trim()}).`;
}

/**
 * Check tmux environment and return warnings for missing recommendations.
 * Called on session creation to guide the user.
 */
export function checkTmuxEnvironment(): string[] {
	const warnings: string[] = [];

	// Check for jixiuf/tmux fork (kitty keyboard protocol support)
	const kittyKeys = tryRun("tmux show-options -s kitty-keys 2>/dev/null");
	if (kittyKeys === null) {
		warnings.push(
			"tmux kitty keyboard protocol not available. Install the jixiuf/tmux fork for full key support: https://github.com/jixiuf/tmux",
		);
	}

	return warnings;
}
