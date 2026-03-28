/**
 * Terminal attach — tmux-native implementation.
 *
 * Uses link-window and join-pane to bring tool windows into pi's session.
 * No nesting, no external dependencies. Native iTerm2 tabs and splits via CC.
 */
import type { AttachLayout } from "./types.js";

export function hasAttachedPane(_tmuxSession: string): boolean {
	// Inside tmux the CC client is always connected — not a user-visible pane.
	return false;
}

export function closeAttachedSessions(_tmuxSession: string): void {
	// Nothing to clean up inside tmux — panes are managed natively.
}

export function openTerminal(_session: string, _mode: AttachLayout, _tmuxWindow?: number): string {
	// In tmux CC mode the view pane (pane 1 of window 0) is always visible.
	// Switching between commands is done via swap-pane (actionFocus).
	// No terminal open needed.
	return "View pane is already visible.";
}
