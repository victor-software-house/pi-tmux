/**
 * pi-tmux — tmux session management per project.
 *
 * Tool: tmux (run/attach/focus/close/peek/list/kill/mute — gated by settings)
 * Commands: /tmux (settings), /tmux list|cat|clear|kill|attach|tab|split|hsplit
 *           /tmux-promote (legacy, only outside tmux)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { isCmux, isTmux } from "@victor-software-house/pi-terminal-env";
import type { AttachLayout, ShellMode, SilenceConfig } from "./types.js";
import { loadSettings, getFlags } from "./settings.js";
import { hasAttachedPane, checkTmuxEnvironment } from "./terminal-tmux.js";
import { trackCompletionByPane, stopCompletionTracking, sendInterrupt, registerSilence, stopAll } from "./signals.js";
import { actionRun, actionAttach, actionFocus, actionClose, actionPeek, actionList, actionKill, actionMute } from "./actions.js";
import type { HostTarget } from "./actions.js";
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

const OUTSIDE_TMUX_ERROR =
	"Error: pi-tmux requires tmux CC mode. Run /tmux-promote to move this session into tmux.";

/**
 * Outside-tmux gate.
 *
 * Registers only /tmux-promote and a stub tool that returns a clear error
 * for every action. Shows a warning notification on session_start.
 */
function registerOutsideTmuxGate(pi: ExtensionAPI): void {
	registerPromoteCommand(pi);

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.notify(
			"pi-tmux requires tmux CC mode. Use /tmux-promote to move this session into tmux.",
			"warning",
		);
	});

	const currentSettings = loadSettings();
	const flags = getFlags(currentSettings);

	pi.registerTool({
		name: "tmux",
		label: "tmux",
		description: buildDescription(flags),
		promptSnippet: "pi-tmux is not active. Pi is not running inside tmux CC mode. Use /tmux-promote to move this session into tmux.",
		parameters: buildParams(flags),

		async execute() {
			return {
				content: [{ type: "text" as const, text: OUTSIDE_TMUX_ERROR }],
				details: {},
			};
		},

		renderCall(args, theme) {
			return new Text(theme.fg("error", "tmux (not in tmux CC mode)"), 0, 0);
		},

		renderResult(_result, _opts, theme) {
			return new Text(theme.fg("error", OUTSIDE_TMUX_ERROR), 0, 0);
		},
	});
}

export default function (pi: ExtensionAPI) {
	// cmux is itself a Ghostty-based multiplexer with its own pane model,
	// notification rings, and surface lifecycle. Operators inside cmux do
	// not need pi-tmux's CC-mode plumbing; routing them through tmux would
	// double-multiplex with nothing to gain. Hard short-circuit here — no
	// /tmux-promote registration, no warning notify, no stub tool.
	if (isCmux()) return;

	if (!isTmux()) {
		registerOutsideTmuxGate(pi);
		return;
	}

	let currentSettings = loadSettings();

	initCommandSettings(currentSettings);
	initCommandPi(pi);

	// session_start fires for startup, new, resume, fork, and reload (Pi 0.65+).
	// This single handler replaces the removed session_switch and session_fork events.
	pi.on("session_start", async (event, ctx) => {
		currentSettings = loadSettings();
		initCommandSettings(currentSettings);
		rehydrate(ctx.sessionManager);

		// Surface tmux environment warnings only on first startup, not on resume/fork
		if (event.reason === "startup") {
			for (const warning of checkTmuxEnvironment()) {
				ctx.ui.notify(warning, "warning");
			}
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
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

	const params = buildParams(flags);

	pi.registerTool({
		name: "tmux",
		label: "tmux",
		description: buildDescription(flags),
		promptSnippet: buildPromptSnippet(flags),
		promptGuidelines: buildPromptGuidelines(flags),
		parameters: params,

		prepareArguments(args) {
			// Normalize legacy argument shapes from resumed sessions.
			// Runs before schema validation — see Pi docs extensions.md.
			if (!args || typeof args !== "object") return { action: "list" };

			const input = args as {
				action?: string;
				limit?: number;
				shellMode?: string;
				[k: string]: unknown;
			};

			// 'limit' added in OUTPUT-TRACK — coerce non-number values
			if (input.limit !== undefined && typeof input.limit !== "number") {
				const n = Number(input.limit);
				input.limit = Number.isFinite(n) && n > 0 ? n : undefined;
			}

			// Guard shellMode type
			if (input.shellMode !== undefined && typeof input.shellMode !== "string") {
				input.shellMode = String(input.shellMode);
			}

			return { action: "list", ...input };
		},

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const binding = getOrCreateBinding(pi, ctx.sessionManager, ctx.cwd);
			const session = binding.tmuxSessionName;
			const host: HostTarget = {
				session: binding.hostSessionName,
				windowIndex: binding.hostWindowIndex,
			};

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
						host,
					});
					if (!result.ok) return toToolResult(result);

					const { paneId, windowName, created } = result.details as Record<string, unknown>;

					if (created === true) {
						notifySessionCreated(pi, ctx.sessionManager, session, commandCwd);
					}

					if (paneId) {
						trackCompletionByPane(
							pi,
							session,
							paneId as string,
							windowName as string,
							currentSettings.completionDelivery,
							currentSettings.completionTriggerTurn,
							currentSettings.completionPollIntervalMs,
						);

						// Wire cancellation: send C-c and stop tracking when the tool call is aborted
						if (signal) {
							const pId = paneId as string;
							signal.addEventListener("abort", () => {
								sendInterrupt(pId);
								stopCompletionTracking(pId);
							}, { once: true });
						}
					}

					const timeout = params.silenceTimeout ?? 0;
					if (timeout > 0 && !paneId) {
						const silence: SilenceConfig = {
							timeout,
							factor: params.silenceBackoffFactor ?? 1.5,
							cap: params.silenceBackoffCap ?? 300,
						};
						const { stagingIdx } = result.details as Record<string, unknown>;
						registerSilence(session, stagingIdx as number, silence);
					}

					return {
						content: [{ type: "text", text: result.message }],
						details: result.details ?? {},
					};
				}

				case "attach": {
					if (!flags.canAttach) {
						return toToolResult({ ok: false, message: "Error: attach is disabled in settings. Use /tmux attach manually." });
					}
					const layout = (params.mode as AttachLayout | undefined) ?? currentSettings.defaultLayout;
					return toToolResult(actionAttach(session, ctx.cwd, { layout, window: params.window, host }));
				}

				case "focus": {
					if (params.window === undefined) {
						return toToolResult({ ok: false, message: "Error: 'window' is required for focus." });
					}
					return toToolResult(actionFocus(session, params.window, host));
				}

				case "close": {
					if (params.window === undefined) {
						return toToolResult({ ok: false, message: "Error: 'window' is required for close. Use kill to close the entire session." });
					}
					return toToolResult(actionClose(session, params.window, host));
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
					const limit = typeof params.limit === "number" && params.limit > 0 ? params.limit : 50;
					return toToolResult(actionPeek(session, target, host, limit));
				}

				case "list":
					return toToolResult(actionList(session, host));

				case "kill":
					return toToolResult(actionKill(session, host));

				case "mute": {
					if (!flags.canMute) {
						return toToolResult({ ok: false, message: "Error: mute is disabled in settings." });
					}
					if (params.window === undefined || params.window === "all") {
						return toToolResult({ ok: false, message: "Error: 'window' target required for mute." });
					}
					const muteTarget = typeof params.window === "number" ? params.window : Number.isNaN(Number.parseInt(String(params.window), 10)) ? String(params.window) : Number.parseInt(String(params.window), 10);
					return toToolResult(actionMute(session, muteTarget, host));
				}

				default:
					return toToolResult({ ok: false, message: `Unknown action: ${params.action}` });
			}
		},

		renderCall(args, theme) {
			const call = args as {
				action?: string;
				command?: string;
				name?: string;
				mode?: string;
				window?: string | number;
			};
			let text = theme.fg("toolTitle", theme.bold("tmux "));
			text += theme.fg("accent", call.action ?? "tmux");
			if (call.action === "run" && call.command) {
				const prefix = call.name ? theme.fg("text", `${call.name}: `) : "";
				text += `\n  ${prefix}${theme.fg("muted", call.command)}`;
			} else if (call.action === "attach" && call.mode && call.mode !== "split-vertical") {
				text += theme.fg("muted", ` (${call.mode})`);
			} else if (call.action === "peek" && call.window !== undefined) {
				text += theme.fg("muted", ` :${call.window}`);
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
