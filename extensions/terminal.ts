/**
 * Terminal API dispatcher.
 *
 * Picks the tmux-native or legacy implementation at load time based on
 * process.env.TMUX. All other modules import from here.
 */
import type { AttachLayout } from "./types.js";

export interface TerminalAPI {
	hasAttachedPane(tmuxSession: string): boolean;
	closeAttachedSessions(tmuxSession: string): void;
	openTerminal(session: string, mode: AttachLayout, tmuxWindow?: number): string;
}

function loadImpl(): TerminalAPI {
	if (process.env.TMUX) {
		return require("./terminal-tmux.js") as TerminalAPI;
	}
	return require("./terminal-legacy.js") as TerminalAPI;
}

const impl = loadImpl();

export const hasAttachedPane = impl.hasAttachedPane;
export const closeAttachedSessions = impl.closeAttachedSessions;
export const openTerminal = impl.openTerminal;

// Re-export for promote.ts (legacy only, no-op in tmux)
export function getActiveiTermSession(): string | null {
	if (process.env.TMUX) return null;
	const legacy = require("./terminal-legacy.js");
	return legacy.getActiveiTermSession();
}

/** Attach to the project's tmux session. */
export function attachToSession(
	cwd: string,
	opts?: { mode?: AttachLayout; tmuxWindow?: number },
): string {
	const { resolveProjectRoot, deriveSessionName, isSessionAlive } = require("./session.js");
	const { loadSettings } = require("./settings.js");
	const root = resolveProjectRoot(cwd);
	const session = deriveSessionName(root);
	if (!isSessionAlive(session)) return "No tmux session for this project.";

	const settings = loadSettings();
	const mode = opts?.mode ?? settings.defaultLayout;

	try {
		return openTerminal(session, mode, opts?.tmuxWindow);
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		return `Failed: ${msg}\nRun manually:\n  tmux attach -t ${session}`;
	}
}
