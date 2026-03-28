/**
 * pi-tmux — tmux session management per project.
 *
 * Tool: tmux (run/attach/focus/close/peek/list/kill/mute — gated by settings)
 * Commands: /tmux (settings), /tmux list|cat|clear|kill|attach|tab|split|hsplit
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { AttachLayout, SilenceConfig } from "./types.js";
import { loadSettings, getFlags } from "./settings.js";
import { resolveProjectRoot, deriveSessionName } from "./session.js";
import { getActiveiTermSession, hasAttachedPane } from "./terminal.js";
import { trackCompletion, registerSilence, stopAll } from "./signals.js";
import { actionRun, actionAttach, actionFocus, actionClose, actionPeek, actionList, actionKill, actionMute } from "./actions.js";
import { buildParams, buildDescription, buildPromptSnippet, buildPromptGuidelines } from "./tool-builder.js";
import { registerTmuxCommand, initCommandSettings } from "./command.js";

function toToolResult(result: { ok: boolean; message: string; details?: Record<string, unknown> }) {
	return {
		content: [{ type: "text" as const, text: result.message }],
		details: result.details ?? {},
	};
}

export default function (pi: ExtensionAPI) {
	let currentSettings = loadSettings();
	let piSessionId: string | null = null;

	function capturePiSession(): void {
		if (process.env.TERM_PROGRAM === "iTerm.app") {
			piSessionId = getActiveiTermSession();
		}
	}

	initCommandSettings(currentSettings);

	pi.on("session_start", async (_event, _ctx) => {
		capturePiSession();
		currentSettings = loadSettings();
		initCommandSettings(currentSettings);
	});

	pi.on("session_switch", async () => {
		currentSettings = loadSettings();
		initCommandSettings(currentSettings);
	});

	pi.on("session_tree", async () => {
		currentSettings = loadSettings();
		initCommandSettings(currentSettings);
	});

	pi.on("session_fork", async () => {
		currentSettings = loadSettings();
		initCommandSettings(currentSettings);
	});

	pi.on("session_shutdown", async () => {
		stopAll();
	});

	registerTmuxCommand(pi, () => piSessionId);

	// /tmux-promote — only registered when pi is NOT inside tmux
	if (!process.env.TMUX) {
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

				// Build pi command from runtime APIs — no process.argv guessing
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

				// Open a new iTerm tab: close old tab once pi exits, then attach via CC mode
				const { execSync: ex } = await import("child_process");
				const sid = piSessionId;
				const closeOld = sid
					? `while ! it2api get-prompt ${sid} 2>/dev/null | grep -q working_directory; do :; done; it2api send-text ${sid} 'exit\n'; `
					: "";
				try {
					ex(`it2api create-tab --command "${closeOld}tmux -CC attach -t ${q(tmuxSession)}"`, { stdio: "ignore" });
				} catch {
					// iTerm2 not available — user must attach manually
				}

				ctx.ui.notify("Promoting session into tmux...", "info");
				ctx.shutdown();
			},
		});
	}

	const flags = getFlags(currentSettings);

	pi.registerTool({
		name: "tmux",
		label: "tmux",
		description: buildDescription(flags),
		promptSnippet: buildPromptSnippet(flags),
		promptGuidelines: buildPromptGuidelines(flags),
		parameters: buildParams(flags),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const root = resolveProjectRoot(ctx.cwd);
			const session = deriveSessionName(root);

			switch (params.action) {
				case "run": {
					if (!params.command) {
						return toToolResult({ ok: false, message: "Error: 'command' is required." });
					}

					const result = actionRun(session, {
						command: params.command,
						name: params.name,
						cwd: params.cwd ?? root,
						windowReuse: currentSettings.windowReuse,
						maxWindows: currentSettings.maxWindows,
						autoFocus: currentSettings.autoFocus,
					});
					if (!result.ok) return toToolResult(result);

					const { windowIndex, created } = result.details as Record<string, unknown>;
					const winIdx = windowIndex as number;

					// Pi-specific side effects
					trackCompletion(pi, session, winIdx, currentSettings.completionDelivery, currentSettings.completionTriggerTurn);

					const timeout = params.silenceTimeout ?? 0;
					if (timeout > 0) {
						const silence: SilenceConfig = {
							timeout,
							factor: params.silenceBackoffFactor ?? 1.5,
							cap: params.silenceBackoffCap ?? 300,
						};
						registerSilence(session, winIdx, silence);
					}

					// Auto-attach (setting-driven, not per-call)
					let message = result.message;
					if (flags.canAttach && !hasAttachedPane(session)) {
						const autoFires =
							currentSettings.autoAttach === "always" ||
							(currentSettings.autoAttach === "session-create" && created === true);
						if (autoFires) {
							const attach = actionAttach(session, ctx.cwd, {
								layout: currentSettings.defaultLayout,
								window: winIdx,
								piSessionId,
							});
							message += "\n" + attach.message;
						}
					}

					return {
						content: [{ type: "text", text: message }],
						details: result.details ?? {},
					};
				}

				case "attach": {
					if (!flags.canAttach) {
						return toToolResult({ ok: false, message: "Error: attach is disabled in settings. Use /tmux attach manually." });
					}
					const layout = (params.mode as AttachLayout | undefined) ?? currentSettings.defaultLayout;
					return toToolResult(actionAttach(session, ctx.cwd, { layout, window: params.window, piSessionId }));
				}

				case "focus": {
					if (params.window === undefined) {
						return toToolResult({ ok: false, message: "Error: 'window' is required for focus." });
					}
					return toToolResult(actionFocus(session, params.window));
				}

				case "close": {
					if (params.window === undefined) {
						return toToolResult({ ok: false, message: "Error: 'window' is required for close. Use kill to close the entire session." });
					}
					return toToolResult(actionClose(session, params.window));
				}

				case "peek": {
					const target =
						params.window === undefined || params.window === "all"
							? ("all" as const)
							: typeof params.window === "number"
								? params.window
								: parseInt(String(params.window), 10);
					return toToolResult(actionPeek(session, typeof target === "number" && Number.isNaN(target) ? "all" : target));
				}

				case "list":
					return toToolResult(actionList(session));

				case "kill":
					return toToolResult(actionKill(session));

				case "mute": {
					if (!flags.canMute) {
						return toToolResult({ ok: false, message: "Error: mute is disabled in settings." });
					}
					if (params.window === undefined || params.window === "all") {
						return toToolResult({ ok: false, message: "Error: 'window' index required for mute." });
					}
					const muteIdx = typeof params.window === "number" ? params.window : parseInt(String(params.window), 10);
					if (Number.isNaN(muteIdx)) {
						return toToolResult({ ok: false, message: `Error: invalid window index '${params.window}'.` });
					}
					return toToolResult(actionMute(session, muteIdx));
				}

				default:
					return toToolResult({ ok: false, message: `Unknown action: ${params.action}` });
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("tmux "));
			text += theme.fg("accent", args.action ?? "tmux");
			if (args.action === "run" && args.command) {
				const prefix = args.name ? theme.fg("text", `${args.name}: `) : "";
				text += `\n  ${prefix}${theme.fg("muted", args.command)}`;
			} else if (args.action === "attach" && args.mode && args.mode !== "split-vertical") {
				text += theme.fg("muted", ` (${args.mode})`);
			} else if (args.action === "peek" && args.window !== undefined) {
				text += theme.fg("muted", ` :${args.window}`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const first = result.content?.[0];
			const raw = first?.type === "text" ? first.text : "";
			if (raw.startsWith("Error:") || raw.startsWith("Failed")) {
				return new Text(theme.fg("error", raw), 0, 0);
			}
			const [summary, ...rest] = raw.split("\n");
			let text = `${theme.fg("success", "*")} ${summary ?? ""}`;
			if (expanded && rest.length > 0) {
				text += "\n" + theme.fg("dim", rest.join("\n"));
			}
			return new Text(text, 0, 0);
		},
	});
}
