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
	const piSession = getPiSession();
	if (!piSession) return "Cannot determine current tmux session.";

	const targetWindow = tmuxWindow ?? 0;

	if (mode === "split-vertical" || mode === "split-horizontal") {
		const flag = mode === "split-vertical" ? "-h" : "-v";
		const result = tryRun(`tmux join-pane ${flag} -s ${session}:${targetWindow} -t ${piSession}`);
		if (result === null) {
			return `Failed to join pane from ${session}:${targetWindow}.`;
		}
		return `Opened ${mode.replace("split-", "")} split from ${session}:${targetWindow}.`;
	}

	const result = tryRun(`tmux link-window -s ${session}:${targetWindow} -t ${piSession}`);
	if (result === null) {
		return `Failed to link window from ${session}:${targetWindow}.`;
	}
	return `Linked ${session}:${targetWindow} as tab in ${piSession}.`;
}
