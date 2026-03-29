/**
 * pi-tmux — tmux session management per project.
 *
 * Tool: tmux (run/attach/focus/close/peek/list/kill/mute — gated by settings)
 * Commands: /tmux (settings), /tmux list|cat|clear|kill|attach|tab|split|hsplit
 *           /tmux-promote (legacy, only outside tmux)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { AttachLayout, ShellMode, SilenceConfig } from "./types.js";
import { loadSettings, getFlags } from "./settings.js";
import { hasAttachedPane } from "./terminal.js";
import { trackCompletion, trackCompletionByPane, registerSilence, stopAll } from "./signals.js";
import { actionRun, actionAttach, actionFocus, actionClose, actionPeek, actionList, actionKill, actionMute } from "./actions.js";
import { buildParams, buildDescription, buildPromptSnippet, buildPromptGuidelines } from "./tool-builder.js";
import { registerTmuxCommand, initCommandSettings, initCommandPi } from "./command.js";
import { registerPromoteCommand } from "./promote.js";
import { getOrCreateBinding, rehydrate, clearCache, notifySessionCreated } from "./state.js";
function toToolResult(result: { ok: boolean; message: string; details?: Record<string, unknown> }) {
	return {
		content: [{ type: "text" as const, text: result.message }],
		details: result.details ?? {},
	};
}

export default function (pi: ExtensionAPI) {
	let currentSettings = loadSettings();

	initCommandSettings(currentSettings);
	initCommandPi(pi);

	pi.on("session_start", async (_event, ctx) => {
		currentSettings = loadSettings();
		initCommandSettings(currentSettings);
		rehydrate(ctx.sessionManager);
	});

	pi.on("session_switch", async (_event, ctx) => {
		currentSettings = loadSettings();
		initCommandSettings(currentSettings);
		rehydrate(ctx.sessionManager);
	});

	pi.on("session_tree", async (_event, ctx) => {
		currentSettings = loadSettings();
		initCommandSettings(currentSettings);
		rehydrate(ctx.sessionManager);
	});

	pi.on("session_fork", async (_event, ctx) => {
		currentSettings = loadSettings();
		initCommandSettings(currentSettings);
		rehydrate(ctx.sessionManager);
	});

	pi.on("session_shutdown", async () => {
		stopAll();
		clearCache();
	});

	registerTmuxCommand(pi);
	registerPromoteCommand(pi);

	const flags = getFlags(currentSettings);

	pi.registerTool({
		name: "tmux",
		label: "tmux",
		description: buildDescription(flags),
		promptSnippet: buildPromptSnippet(flags),
		promptGuidelines: buildPromptGuidelines(flags),
		parameters: buildParams(flags),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const binding = getOrCreateBinding(pi, ctx.sessionManager, ctx.cwd);
			const session = binding.tmuxSessionName;
			const hostSession = binding.hostSessionName;
			const hostWindowIndex = binding.hostWindowIndex;

			switch (params.action) {
				case "run": {
					if (!params.command) {
						return toToolResult({ ok: false, message: "Error: 'command' is required." });
					}

					const shellMode = (params.shellMode as ShellMode | undefined) ?? currentSettings.defaultShellMode;
					const commandCwd = params.cwd ?? ctx.cwd;
					const result = await actionRun(session, {
						command: params.command,
						name: params.name,
						cwd: commandCwd,
						windowReuse: currentSettings.windowReuse,
						maxWindows: currentSettings.maxWindows,
						autoFocus: currentSettings.autoFocus,
						defaultLayout: currentSettings.defaultLayout,
						shellMode,
						target: params.window,
						hostSession,
						hostWindowIndex,
					});
					if (!result.ok) return toToolResult(result);

					const { windowIndex, paneId, windowName, created } = result.details as Record<string, unknown>;

					// Notify state layer when a new tmux session was created
					if (created === true) {
						notifySessionCreated(pi, ctx.sessionManager, session, commandCwd);
					}

					if (paneId) {
						// Tmux mode: track by pane ID (works even when pane swaps between sessions)
						trackCompletionByPane(
							pi,
							session,
							paneId as string,
							windowName as string,
							currentSettings.completionDelivery,
							currentSettings.completionTriggerTurn,
							currentSettings.completionPollIntervalMs,
						);
					} else {
						const winIdx = windowIndex as number;
						trackCompletion(
							pi,
							session,
							winIdx,
							currentSettings.completionDelivery,
							currentSettings.completionTriggerTurn,
							currentSettings.completionPollIntervalMs,
						);
					}

							const timeout = params.silenceTimeout ?? 0;
					if (timeout > 0 && !paneId) {
						const silence: SilenceConfig = {
							timeout,
							factor: params.silenceBackoffFactor ?? 1.5,
							cap: params.silenceBackoffCap ?? 300,
						};
						registerSilence(session, windowIndex as number, silence);
					}

					// Auto-attach (no-op in tmux mode — view pane already swapped in)
					let message = result.message;
					if (!paneId && flags.canAttach && !hasAttachedPane(session)) {
						const autoFires =
							currentSettings.autoAttach === "always" ||
							(currentSettings.autoAttach === "session-create" && created === true);
						if (autoFires) {
							const attach = actionAttach(session, ctx.cwd, {
								layout: currentSettings.defaultLayout,
								window: windowIndex as number,
								hostSession,
								hostWindowIndex,
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
					return toToolResult(actionAttach(session, ctx.cwd, { layout, window: params.window, hostSession, hostWindowIndex }));
				}

				case "focus": {
					if (params.window === undefined) {
						return toToolResult({ ok: false, message: "Error: 'window' is required for focus." });
					}
					return toToolResult(actionFocus(session, params.window, hostSession, hostWindowIndex));
				}

				case "close": {
					if (params.window === undefined) {
						return toToolResult({ ok: false, message: "Error: 'window' is required for close. Use kill to close the entire session." });
					}
					return toToolResult(actionClose(session, params.window, hostSession, hostWindowIndex));
				}

				case "peek": {
					const target =
						params.window === undefined || params.window === "all"
							? ("all" as const)
							: typeof params.window === "number"
								? params.window
								: Number.isNaN(Number.parseInt(String(params.window), 10))
									? String(params.window)
									: Number.parseInt(String(params.window), 10);
					return toToolResult(actionPeek(session, target, hostSession, hostWindowIndex));
				}

				case "list":
					return toToolResult(actionList(session, hostSession, hostWindowIndex));

				case "kill":
					return toToolResult(actionKill(session, hostSession, hostWindowIndex));

				case "mute": {
					if (!flags.canMute) {
						return toToolResult({ ok: false, message: "Error: mute is disabled in settings." });
					}
					if (params.window === undefined || params.window === "all") {
						return toToolResult({ ok: false, message: "Error: 'window' target required for mute." });
					}
					const muteTarget = typeof params.window === "number" ? params.window : Number.isNaN(Number.parseInt(String(params.window), 10)) ? String(params.window) : Number.parseInt(String(params.window), 10);
					return toToolResult(actionMute(session, muteTarget, hostSession, hostWindowIndex));
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
