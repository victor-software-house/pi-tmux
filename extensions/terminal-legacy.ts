/**
 * Legacy terminal attach — outside-tmux fallback.
 * Deprecated: use /tmux-promote to move pi into tmux first.
 */
import type { AttachLayout, AttachOptions } from "./types.js";
import { run, tryRun, tmuxEscape } from "./session.js";

const IT2API = "/Applications/iTerm.app/Contents/Resources/utilities/it2api";
const IT2API_INSTALL_HINT = "Enable: iTerm2 > Settings > General > Magic > Enable Python API. Then: uv pip install --system iterm2";

let _it2apiAvailable: boolean | null = null;

function isIt2apiAvailable(): boolean {
	if (_it2apiAvailable === null) {
		_it2apiAvailable = tryRun(`${IT2API} list-sessions 2>/dev/null`) !== null;
	}
	return _it2apiAvailable;
}

export function getActiveiTermSession(): string | null {
	if (!isIt2apiAvailable()) return null;
	const raw = tryRun(`${IT2API} show-focus 2>/dev/null`);
	if (!raw) return null;
	const match = raw.match(/id=([0-9A-F-]{36})/);
	return match?.[1] ?? null;
}

function getActiveiTermWindow(): string | null {
	if (!isIt2apiAvailable()) return null;
	const raw = tryRun(`${IT2API} show-focus 2>/dev/null`);
	if (!raw) return null;
	const match = raw.match(/Key window:\s*(pty-[0-9A-F-]+)/);
	return match?.[1] ?? null;
}

const legacyAttachedPanes = new Map<string, Set<string>>();

function trackPane(tmuxSession: string, itermId: string): void {
	let panes = legacyAttachedPanes.get(tmuxSession);
	if (!panes) {
		panes = new Set();
		legacyAttachedPanes.set(tmuxSession, panes);
	}
	panes.add(itermId);
}

export { closeLegacyAttachedSessions as closeAttachedSessions };
function closeLegacyAttachedSessions(tmuxSession: string): void {
	const panes = legacyAttachedPanes.get(tmuxSession);
	if (!panes || !isIt2apiAvailable()) return;
	for (const paneId of panes) {
		tryRun(`${IT2API} send-text "${paneId}" "\x03"`);
		tryRun(`${IT2API} send-text "${paneId}" "exit\n"`);
	}
	legacyAttachedPanes.delete(tmuxSession);
}

export { hasLegacyAttachedPane as hasAttachedPane };
function hasLegacyAttachedPane(tmuxSession: string): boolean {
	const clients = tryRun(`tmux list-clients -t ${tmuxSession} -F "#{client_tty}" 2>/dev/null`);
	return clients !== null && clients.trim().length > 0;
}

export function openTerminal(session: string, mode: AttachLayout, tmuxWindow?: number): string {
	return openLegacy({ session, tmuxWindow }, mode);
}

function openLegacy(opts: AttachOptions, mode: AttachLayout): string {
	const { session, tmuxWindow } = opts;
	const term = process.env.TERM_PROGRAM ?? "";
	const attachCmd = `tmux attach -t ${session}`;

	if (tmuxWindow !== undefined) {
		tryRun(`tmux select-window -t ${session}:${tmuxWindow}`);
	}

	switch (term) {
		case "iTerm.app": {
			const isSplit = mode === "split-vertical" || mode === "split-horizontal";
			const label = isSplit ? `${mode.replace("split-", "")} split` : "tab";

			const targetSession = opts.piSessionId ?? getActiveiTermSession();
			if (targetSession) {
				if (isSplit) {
					const flag = mode === "split-vertical" ? " --vertical" : "";
					const result = tryRun(`${IT2API} split-pane${flag} "${targetSession}"`);
					const newId = result?.match(/id=([0-9A-F-]{36})/)?.[1];
					if (newId) {
						trackPane(session, newId);
						tryRun(`${IT2API} send-text "${newId}" "exec ${tmuxEscape(attachCmd)}\n"`);
						return `Opened iTerm2 ${label} attached to ${session}.`;
					}
				} else {
					const windowId = getActiveiTermWindow();
					const windowFlag = windowId ? ` --window "${windowId}"` : "";
					const result = tryRun(`${IT2API} create-tab${windowFlag}`);
					const newId = result?.match(/id=([0-9A-F-]{36})/)?.[1];
					if (newId) {
						trackPane(session, newId);
						tryRun(`${IT2API} send-text "${newId}" "exec ${tmuxEscape(attachCmd)}\n"`);
						return `Opened iTerm2 tab attached to ${session}.`;
					}
				}
			}

			const warning = `\x1b[33m[pi-tmux] iTerm2 Python API not available. Using legacy attach.\n${IT2API_INSTALL_HINT}\x1b[0m`;
			if (isSplit) {
				const direction = mode === "split-vertical" ? "vertically" : "horizontally";
				run(`osascript -e '
          tell application "iTerm2"
            tell current session of current window
              set newSession to (split ${direction} with default profile)
              tell newSession
                write text "exec ${tmuxEscape(attachCmd)}"
              end tell
            end tell
          end tell'`);
			} else {
				run(`osascript -e '
          tell application "iTerm2"
            tell current window
              set newTab to (create tab with default profile)
              tell current session of newTab
                write text "exec ${tmuxEscape(attachCmd)}"
              end tell
            end tell
          end tell'`);
			}
			return `${warning}\nOpened iTerm2 ${label} attached to ${session}.`;
		}

		case "Apple_Terminal":
			run(`osascript -e '
        tell application "Terminal"
          activate
          do script "exec ${tmuxEscape(attachCmd)}"
        end tell'`);
			return `Opened Terminal.app window attached to ${session}.`;

		case "kitty":
			run(`kitty @ launch --type=tab ${attachCmd}`);
			return `Opened kitty tab attached to ${session}.`;

		case "ghostty":
			run(`ghostty -e ${attachCmd} &`);
			return `Opened ghostty window attached to ${session}.`;

		case "WezTerm":
			run(`wezterm cli spawn -- ${attachCmd}`);
			return `Opened WezTerm tab attached to ${session}.`;

		default:
			return `No supported terminal detected. Run manually:\n  ${attachCmd}`;
	}
}
