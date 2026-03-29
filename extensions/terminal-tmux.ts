/**
 * Terminal attach — tmux-native (CC mode) implementation.
 *
 * In CC mode, tmux split-window / new-window create visible iTerm2
 * panes and tabs. The view pane (pane 1 of window 0) is created by
 * ensureViewPane() in session.ts via split-window.
 *
 * This module handles the openTerminal / hasAttachedPane / close contract
 * used by terminal.ts dispatcher when process.env.TMUX is set.
 */
import type { AttachLayout } from "./types.js";
import { tryRun, tmuxSessionTarget } from "./session.js";

// Track the view pane ID so we know if we already have one.
let viewPaneId: string | null = null;

export function hasAttachedPane(_tmuxSession: string): boolean {
	if (!viewPaneId) return false;
	// Verify the pane still exists
	const check = tryRun(`tmux display-message -t ${viewPaneId} -p '#{pane_id}' 2>/dev/null`);
	if (!check) {
		viewPaneId = null;
		return false;
	}
	return true;
}

export function closeAttachedSessions(_tmuxSession: string): void {
	if (!viewPaneId) return;
	tryRun(`tmux kill-pane -t ${viewPaneId}`);
	viewPaneId = null;
}

export function openTerminal(session: string, mode: AttachLayout, _tmuxWindow?: number): string {
	const isSplit = mode === "split-vertical" || mode === "split-horizontal";

	if (isSplit) {
		// Check if view pane already exists (pane 1 of window 0)
		const panes = tryRun(`tmux list-panes -t ${tmuxSessionTarget(session)}:0 -F "#{pane_index} #{pane_id}"`);
		const existing = panes?.split("\n").find((l) => l.startsWith("1 "));
		if (existing) {
			viewPaneId = existing.split(" ")[1] ?? null;
			return "View pane already visible.";
		}

		const flag = mode === "split-vertical" ? "-h" : "-v";
		const raw = tryRun(`tmux split-window ${flag} -t ${tmuxSessionTarget(session)}:0 -d -P -F "#{pane_id}"`);
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
