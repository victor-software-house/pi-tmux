/**
 * Terminal attach — tmux-native implementation.
 *
 * Uses link-window and join-pane to bring tool windows into pi's session.
 * No nesting, no external dependencies. Native iTerm2 tabs and splits via CC.
 */
import type { AttachLayout } from "./types.js";
import { tryRun } from "./session.js";

function getPiSession(): string | null {
	const raw = tryRun("tmux display-message -p '#{session_name}'");
	return raw?.trim() ?? null;
}

export function hasAttachedPane(_tmuxSession: string): boolean {
	// Inside tmux the CC client is always connected — not a user-visible pane.
	return false;
}

export function closeAttachedSessions(_tmuxSession: string): void {
	// Nothing to clean up inside tmux — panes are managed natively.
}

export function openTerminal(session: string, mode: AttachLayout, tmuxWindow?: number): string {
	// Commands run directly in pi's session — windows are native CC tabs.
	// Auto-attach means focusing the target window (it's already visible).
	if (tmuxWindow !== undefined) {
		tryRun(`tmux select-window -t ${session}:${tmuxWindow}`);
		return `Focused :${tmuxWindow} in ${session}.`;
	}

	// No specific window — focus the session's active window.
	tryRun(`tmux select-window -t ${session}`);
	return `Focused active window in ${session}.`;
}
