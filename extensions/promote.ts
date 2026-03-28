/**
 * /tmux-promote — move pi session from bare terminal into tmux CC mode.
 * Legacy command: only registered when pi is NOT already inside tmux.
 * Uses it2api for iTerm2 integration (create-tab, get-prompt, send-text).
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { resolveProjectRoot, deriveSessionName } from "./session.js";
export function registerPromoteCommand(pi: ExtensionAPI): void {
	if (process.env.TMUX) return;

	// Lazy import — only loaded outside tmux
	const { getActiveiTermSession } = require("./terminal-legacy.js");
	const piSessionId = getActiveiTermSession() as string | null;

	pi.registerCommand("tmux-promote", {
		description: "Re-launch this pi session inside tmux for native scrolling and splits",
		handler: async (_args, ctx) => {
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) {
				ctx.ui.notify("Cannot promote: no active session file.", "error");
				return;
			}

			const root = resolveProjectRoot(ctx.cwd);
			const tmuxSession = deriveSessionName(root);

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
			tr(`tmux kill-session -t ${q(tmuxSession)} 2>/dev/null`);
			r(`tmux new-session -d -s ${q(tmuxSession)} -c ${q(root)} ${q(piCmd)}`);
			// Mark pi's pane ID in the session environment for reliable identification
			const piPaneId = tr(`tmux display-message -t ${q(tmuxSession)}:0 -p "#{pane_id}"`);
			if (piPaneId) {
				tr(`tmux set-environment -t ${q(tmuxSession)} PI_PANE_ID ${piPaneId.trim()}`);
			}

			// Open new iTerm tab with CC attach, close old tab after pi exits
			const { execSync: ex } = await import("child_process");
			const closeOld = piSessionId
				? `while ! it2api get-prompt ${piSessionId} 2>/dev/null | grep -q working_directory; do :; done; it2api send-text ${piSessionId} 'exit\\n'; `
				: "";
			const script = `${closeOld}tmux -CC attach -t ${q(tmuxSession)}`;
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
