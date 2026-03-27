/**
 * Terminal attach — iTerm2, Terminal.app, kitty, ghostty, WezTerm, nested tmux.
 * Tracks attached iTerm sessions for cleanup on kill.
 */
import type { AttachLayout, AttachOptions } from "./types.js";
import { exec, execSafe, getProjectRoot, sessionName, sessionExists, escapeForTmux } from "./session.js";
import { loadSettings } from "./settings.js";

const IT2API = "/Applications/iTerm.app/Contents/Resources/utilities/it2api";
const IT2API_INSTALL_HINT = "Enable: iTerm2 > Settings > General > Magic > Enable Python API. Then: uv pip install --system iterm2";

let _it2apiAvailable: boolean | null = null;

export function isIt2apiAvailable(): boolean {
	if (_it2apiAvailable === null) {
		_it2apiAvailable = execSafe(`${IT2API} list-sessions 2>/dev/null`) !== null;
	}
	return _it2apiAvailable;
}

export function getActiveiTermSession(): string | null {
	if (!isIt2apiAvailable()) return null;
	const raw = execSafe(`${IT2API} show-focus 2>/dev/null`);
	if (!raw) return null;
	const match = raw.match(/id=([0-9A-F-]{36})/);
	return match?.[1] ?? null;
}

function getActiveiTermWindow(): string | null {
	if (!isIt2apiAvailable()) return null;
	const raw = execSafe(`${IT2API} show-focus 2>/dev/null`);
	if (!raw) return null;
	const match = raw.match(/Key window:\s*(pty-[0-9A-F-]+)/);
	return match?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// Attached pane tracking
// ---------------------------------------------------------------------------

const attachedItermSessions = new Map<string, Set<string>>();

function trackAttachedSession(tmuxSession: string, itermSessionId: string): void {
	let set = attachedItermSessions.get(tmuxSession);
	if (!set) {
		set = new Set();
		attachedItermSessions.set(tmuxSession, set);
	}
	set.add(itermSessionId);
}

export function closeAttachedSessions(tmuxSession: string): void {
	const ids = attachedItermSessions.get(tmuxSession);
	if (!ids || !isIt2apiAvailable()) return;
	for (const id of ids) {
		execSafe(`${IT2API} send-text "${id}" "\x03"`);
		execSafe(`${IT2API} send-text "${id}" "exit\n"`);
	}
	attachedItermSessions.delete(tmuxSession);
}

// ---------------------------------------------------------------------------
// Open terminal pane/tab attached to a tmux session
// ---------------------------------------------------------------------------

export function openTerminalTab(opts: AttachOptions): string {
	const { session, tmuxWindow } = opts;
	const settings = loadSettings();
	const mode = opts.mode ?? settings.defaultLayout;
	const term = process.env.TERM_PROGRAM ?? "";

	if (tmuxWindow !== undefined) {
		execSafe(`tmux select-window -t ${session}:${tmuxWindow}`);
	}

	const attachCmd = `tmux attach -t ${session}`;

	if (process.env.TMUX) {
		if (mode === "split-vertical") {
			exec(`tmux split-window -h -t ${session}`);
			return `Opened tmux vertical split in session ${session}.`;
		} else if (mode === "split-horizontal") {
			exec(`tmux split-window -v -t ${session}`);
			return `Opened tmux horizontal split in session ${session}.`;
		} else {
			exec(`tmux new-window -t ${session}`);
			return `Opened tmux tab in session ${session}.`;
		}
	}

	switch (term) {
		case "iTerm.app": {
			const isSplit = mode === "split-vertical" || mode === "split-horizontal";
			const label = isSplit ? `${mode.replace("split-", "")} split` : "tab";

			const targetSession = opts.piSessionId ?? getActiveiTermSession();
			if (targetSession) {
				if (isSplit) {
					const flag = mode === "split-vertical" ? " --vertical" : "";
					const result = execSafe(`${IT2API} split-pane${flag} "${targetSession}"`);
					const newId = result?.match(/id=([0-9A-F-]{36})/)?.[1];
					if (newId) {
						trackAttachedSession(session, newId);
						execSafe(`${IT2API} send-text "${newId}" "exec ${escapeForTmux(attachCmd)}\n"`);
						return `Opened iTerm2 ${label} attached to ${session}.`;
					}
				} else {
					const windowId = getActiveiTermWindow();
					const windowFlag = windowId ? ` --window "${windowId}"` : "";
					const result = execSafe(`${IT2API} create-tab${windowFlag}`);
					const newId = result?.match(/id=([0-9A-F-]{36})/)?.[1];
					if (newId) {
						trackAttachedSession(session, newId);
						execSafe(`${IT2API} send-text "${newId}" "exec tmux -CC attach -t ${escapeForTmux(session)}\n"`);
						return `Opened iTerm2 tab attached to ${session}.`;
					}
				}
			}

			const warning = `\x1b[33m[pi-tmux] iTerm2 Python API not available. Using legacy attach (no native integration).\n${IT2API_INSTALL_HINT}\x1b[0m`;
			if (isSplit) {
				const direction = mode === "split-vertical" ? "vertically" : "horizontally";
				exec(`osascript -e '
          tell application "iTerm2"
            tell current session of current window
              set newSession to (split ${direction} with default profile)
              tell newSession
                write text "exec ${escapeForTmux(attachCmd)}"
              end tell
            end tell
          end tell'`);
			} else {
				exec(`osascript -e '
          tell application "iTerm2"
            tell current window
              set newTab to (create tab with default profile)
              tell current session of newTab
                write text "exec ${escapeForTmux(attachCmd)}"
              end tell
            end tell
          end tell'`);
			}
			return `${warning}\nOpened iTerm2 ${label} attached to ${session}.`;
		}

		case "Apple_Terminal":
			exec(`osascript -e '
        tell application "Terminal"
          activate
          do script "exec ${escapeForTmux(attachCmd)}"
        end tell'`);
			return `Opened Terminal.app window attached to ${session}.`;

		case "kitty":
			exec(`kitty @ launch --type=tab ${attachCmd}`);
			return `Opened kitty tab attached to ${session}.`;

		case "ghostty":
			exec(`ghostty -e ${attachCmd} &`);
			return `Opened ghostty window attached to ${session}.`;

		case "WezTerm":
			exec(`wezterm cli spawn -- ${attachCmd}`);
			return `Opened WezTerm tab attached to ${session}.`;

		default:
			return `No supported terminal detected. Run manually:\n  ${attachCmd}`;
	}
}

export function attachToSession(
	cwd: string,
	opts?: { mode?: AttachLayout; tmuxWindow?: number; piSessionId?: string | null },
): string {
	const projectRoot = getProjectRoot(cwd);
	const session = sessionName(projectRoot);
	if (!sessionExists(session)) return "No tmux session for this project.";

	try {
		return openTerminalTab({
			session,
			mode: opts?.mode,
			tmuxWindow: opts?.tmuxWindow,
			piSessionId: opts?.piSessionId,
		});
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		return `Failed: ${msg}\nRun manually:\n  tmux attach -t ${session}`;
	}
}
