/**
 * /tmux-promote — move pi session from bare terminal into tmux CC mode.
 * Only registered when pi is NOT already inside tmux.
 * Uses it2api for iTerm2 integration (create-tab, get-prompt, send-text).
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { resolveProjectRoot, tryRun, tmuxSessionTarget } from "./session.js";
import { getOrCreateBinding } from "./state.js";

const IT2API = "/Applications/iTerm.app/Contents/Resources/utilities/it2api";

let _it2apiAvailable: boolean | null = null;

function isIt2apiAvailable(): boolean {
	if (_it2apiAvailable === null) {
		_it2apiAvailable = tryRun(`${IT2API} list-sessions 2>/dev/null`) !== null;
	}
	return _it2apiAvailable;
}

function getActiveiTermSession(): string | null {
	if (!isIt2apiAvailable()) return null;
	const raw = tryRun(`${IT2API} show-focus 2>/dev/null`);
	if (!raw) return null;
	const match = raw.match(/id=([0-9A-F-]{36})/);
	return match?.[1] ?? null;
}

export function registerPromoteCommand(pi: ExtensionAPI): void {
	if (process.env.TMUX) return;

	const piSessionId = getActiveiTermSession();

	pi.registerCommand("tmux-promote", {
		description: "Re-launch this pi session inside tmux for native scrolling and splits",
		handler: async (_args, ctx) => {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) {
				ctx.ui.notify("Cannot promote: no active session file.", "error");
				return;
			}

			const root = resolveProjectRoot(ctx.cwd);
			const binding = getOrCreateBinding(pi, ctx.sessionManager, ctx.cwd);
			const tmuxSession = binding.tmuxSessionName;

			const args: string[] = ["pi"];
			args.push("--session", sessionFile);

			const model = ctx.model;
			if (model) {
				args.push("--model", `${model.provider}/${model.id}`);
			}

			const thinking = pi.getThinkingLevel();
			if (thinking !== "off") {
				args.push("--thinking", thinking);
			}

			const q = (s: string) => (/[\s'"\\$]/.test(s) ? `'${s.replace(/'/g, "'\\''")}'` : s);
			const piCmd = args.map(q).join(" ");

			const { tryRun: tr, run: r } = await import("./session.js");
			tr(`tmux kill-session -t ${q(tmuxSessionTarget(tmuxSession))} 2>/dev/null`);
			r(`tmux new-session -d -s ${q(tmuxSession)} -c ${q(root)} ${q(piCmd)}`);
			// Mark pi's pane ID in the session environment for reliable identification
			const piPaneId = tr(`tmux display-message -t ${q(tmuxSessionTarget(tmuxSession))}:0 -p "#{pane_id}"`);
			if (piPaneId) {
				tr(`tmux set-environment -t ${q(tmuxSessionTarget(tmuxSession))} PI_PANE_ID ${piPaneId.trim()}`);
			}

			// Open new iTerm tab with CC attach, close old tab after pi exits
			const { execSync: ex } = await import("child_process");
			const closeOld = piSessionId
				? `while ! it2api get-prompt ${piSessionId} 2>/dev/null | grep -q working_directory; do :; done; it2api send-text ${piSessionId} 'exit\\n'; `
				: "";
			const script = `${closeOld}tmux -CC attach -t ${q(tmuxSessionTarget(tmuxSession))}`;
			try {
				ex(`it2api create-tab --command "/bin/bash -l -c '${script.replace(/'/g, "'\\''")}'"`);
			} catch {
				// iTerm2 not available
			}

			ctx.ui.notify("Promoting session into tmux...", "info");
			ctx.shutdown();
		},
	});
}
