/**
 * pi-tmux — tmux session management per project.
 *
 * Tool: tmux (run/peek/list/kill + attach/focus/close/mute gated by settings)
 * Commands: /tmux (settings), /tmux show|cat|clear|kill|attach|tab|split|hsplit
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { AttachLayout, FeatureFlags, SilenceConfig } from "./types.js";
import { loadSettings, getFlags } from "./settings.js";
import { run, tryRun, resolveProjectRoot, deriveSessionName, deriveWindowName, isSessionAlive, isWindowIdle, listWindows, tmuxEscape } from "./session.js";
import { getActiveiTermSession, hasAttachedPane } from "./terminal.js";
import { trackCompletion, registerSilence, clearSilenceForWindow, sendCommand, createWindowWithCommand, startCommandInFirstWindow, stopAll } from "./signals.js";
import { actionAttach, actionFocus, actionClose, actionPeek, actionList, actionKill } from "./actions.js";
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

	const flags: FeatureFlags = getFlags(currentSettings);

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

					const windowName = params.name ? params.name.slice(0, 30) : deriveWindowName(params.command);
					const alive = isSessionAlive(session);
					const reuse = currentSettings.windowReuse;

					const timeout = params.silenceTimeout ?? 0;
					const silence: SilenceConfig | undefined =
						timeout > 0 ? { timeout, factor: params.silenceBackoffFactor ?? 1.5, cap: params.silenceBackoffCap ?? 300 } : undefined;
					const windowCwd = params.cwd ?? root;

					let windowIndex: number;
					let reused = false;

					if (!alive) {
						run(`tmux new-session -d -s ${session} -c "${windowCwd}"`);
						if (silence) run(`tmux set-option -t ${session} silence-action any`);
						startCommandInFirstWindow(session, windowName, params.command);
						windowIndex = 0;
					} else {
						const windows = listWindows(session);

						let reuseCandidate: (typeof windows)[number] | undefined;
						if (reuse !== "never") {
							if (params.name) {
								reuseCandidate = windows
									.filter((w) => w.title === params.name && isWindowIdle(session, w.index))
									.at(-1);
							} else if (reuse === "last") {
								reuseCandidate = [...windows].reverse().find((w) => isWindowIdle(session, w.index));
							}
						}

						if (reuseCandidate) {
							const idx = reuseCandidate.index;
							tryRun(`tmux rename-window -t ${session}:${idx} "${tmuxEscape(windowName)}"`);
							if (silence) tryRun(`tmux set-option -t ${session} silence-action any`);
							sendCommand(session, idx, params.command);
							windowIndex = idx;
							reused = true;
						} else {
							if (windows.length >= currentSettings.maxWindows) {
								return toToolResult({
									ok: false,
									message: `Error: ${windows.length} windows open (max: ${currentSettings.maxWindows}). Clear idle windows first (/tmux:clear).`,
								});
							}
							if (silence) tryRun(`tmux set-option -t ${session} silence-action any`);
							windowIndex = createWindowWithCommand(session, windowCwd, params.command, windowName);
						}
					}

					// Non-blocking completion tracking
					trackCompletion(pi, session, windowIndex, currentSettings.completionDelivery, currentSettings.completionTriggerTurn);

					if (silence) registerSilence(session, windowIndex, silence);

					// Auto-attach (skip if already attached)
					let attachNote = "";
					if (flags.canAttach && !hasAttachedPane(session)) {
						const autoFires =
							currentSettings.autoAttach === "always" ||
							(currentSettings.autoAttach === "session-create" && !alive);
						const shouldAttach = autoFires || params.attach === true;
						if (shouldAttach) {
							const layout = (params.mode as AttachLayout | undefined) ?? currentSettings.defaultLayout;
							const result = actionAttach(session, ctx.cwd, { layout, window: windowIndex, piSessionId });
							attachNote = "\n" + result.message;
						}
					}

					// Auto-focus
					if (currentSettings.autoFocus === "always" && isSessionAlive(session)) {
						tryRun(`tmux select-window -t ${session}:${windowIndex}`);
					}

					const verb = !alive ? "Created" : reused ? "Reused" : "Added to";
					return {
						content: [{ type: "text", text: `${verb} session ${session}\n  :${windowIndex}  ${windowName}: ${params.command}${attachNote}` }],
						details: { session, windowIndex, created: !alive, reused },
					};
				}

				case "attach": {
					if (!flags.canAttach) {
						return toToolResult({ ok: false, message: "Error: attach is disabled in settings. Use /tmux attach manually." });
					}
					const layout = (params.mode as AttachLayout | undefined) ?? currentSettings.defaultLayout;
					const window = typeof params.window === "number" ? params.window : undefined;
					return toToolResult(actionAttach(session, ctx.cwd, { layout, window, piSessionId }));
				}

				case "focus":
					return toToolResult(actionFocus(session, params.window ?? 0));

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
					clearSilenceForWindow(session, muteIdx);
					const windows = listWindows(session);
					const mutedWindow = windows.find((w) => w.index === muteIdx);
					return toToolResult({ ok: true, message: `Muted silence alerts for "${mutedWindow?.title ?? `window ${muteIdx}`}" (:${muteIdx}).` });
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
