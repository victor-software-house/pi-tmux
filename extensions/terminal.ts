/**
 * Terminal attach — open views of the tool's tmux session.
 *
 * Primary: link-window / join-pane when pi runs inside tmux (CC mode).
 * Legacy fallback loaded lazily only when outside tmux.
 */
import type { AttachLayout, AttachOptions } from "./types.js";
import { tryRun, resolveProjectRoot, deriveSessionName, isSessionAlive } from "./session.js";
import { loadSettings } from "./settings.js";

// ---------------------------------------------------------------------------
// Primary: tmux-native attach (link-window / join-pane)
// ---------------------------------------------------------------------------

function getPiSession(): string | null {
	const raw = tryRun("tmux display-message -p '#{session_name}'");
	return raw?.trim() ?? null;
}

function openViaTmux(session: string, mode: AttachLayout, tmuxWindow?: number): string {
	const piSession = getPiSession();
	if (!piSession) return "Cannot determine current tmux session.";

	const srcWindow = tmuxWindow ?? 0;

	if (mode === "split-vertical" || mode === "split-horizontal") {
		const flag = mode === "split-vertical" ? "-h" : "-v";
		const result = tryRun(`tmux join-pane ${flag} -s ${session}:${srcWindow} -t ${piSession}`);
		if (result === null) {
			return `Failed to join pane from ${session}:${srcWindow}.`;
		}
		return `Opened ${mode.replace("split-", "")} split from ${session}:${srcWindow}.`;
	}

	// Tab: link the tool window into pi's session
	const result = tryRun(`tmux link-window -s ${session}:${srcWindow} -t ${piSession}`);
	if (result === null) {
		return `Failed to link window from ${session}:${srcWindow}.`;
	}
	return `Linked ${session}:${srcWindow} as tab in ${piSession}.`;
}

// ---------------------------------------------------------------------------
// Lazy legacy loader (only imported outside tmux)
// ---------------------------------------------------------------------------

let _legacy: typeof import("./terminal-legacy.js") | null = null;

function getLegacySync() {
	if (!_legacy) {
		// Synchronous require fallback — terminal-legacy.js is always bundled
		_legacy = require("./terminal-legacy.js");
	}
	return _legacy!;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Is a user-visible terminal attached to this tool session? */
export function hasAttachedPane(tmuxSession: string): boolean {
	if (process.env.TMUX) return false;
	return getLegacySync().hasLegacyAttachedPane(tmuxSession);
}

/** Clean up attached terminal panes on session kill. */
export function closeAttachedSessions(tmuxSession: string): void {
	if (process.env.TMUX) return;
	getLegacySync().closeLegacyAttachedSessions(tmuxSession);
}

/** Re-export for promote.ts (legacy only) */
export function getActiveiTermSession(): string | null {
	if (process.env.TMUX) return null;
	return getLegacySync().getActiveiTermSession();
}

/** Open a terminal view of the tool session. */
export function openTerminalTab(opts: AttachOptions): string {
	const settings = loadSettings();
	const mode = opts.mode ?? settings.defaultLayout;

	if (process.env.TMUX) {
		return openViaTmux(opts.session, mode, opts.tmuxWindow);
	}

	return getLegacySync().openLegacy(opts, mode);
}

/** Attach to the project's tmux session. */
export function attachToSession(
	cwd: string,
	opts?: { mode?: AttachLayout; tmuxWindow?: number },
): string {
	const root = resolveProjectRoot(cwd);
	const session = deriveSessionName(root);
	if (!isSessionAlive(session)) return "No tmux session for this project.";

	try {
		return openTerminalTab({
			session,
			mode: opts?.mode,
			tmuxWindow: opts?.tmuxWindow,
		});
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		return `Failed: ${msg}\nRun manually:\n  tmux attach -t ${session}`;
	}
}
