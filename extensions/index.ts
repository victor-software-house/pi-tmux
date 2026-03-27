/**
 * pi-tmux — tmux session management per project.
 *
 * Tool: tmux (run/peek/list/kill + attach/mute gated by settings)
 * Commands: /tmux (settings), /tmux show|status|verify|path|reset|attach|tab|split|hsplit|cat|clear|kill|help
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { AttachLayout, FeatureFlags, SilenceConfig } from "./types.js";
import { loadSettings, getFlags } from "./settings.js";
import { run, tryRun, resolveProjectRoot, deriveSessionName, deriveWindowName, isSessionAlive, isWindowIdle, listWindows, resolveWindow, captureOutput, tmuxEscape } from "./session.js";
import { getActiveiTermSession, attachToSession, closeAttachedSessions } from "./terminal.js";
import { trackCompletion, registerSilence, clearSilenceForWindow, sendCommand, createWindowWithCommand, startCommandInFirstWindow, stopAll } from "./signals.js";
import { buildParams, buildDescription, buildPromptSnippet, buildPromptGuidelines } from "./tool-builder.js";
import { registerTmuxCommand, initCommandSettings } from "./command.js";

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
						return { content: [{ type: "text", text: "Error: 'command' is required." }], details: {} };
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
							} else if (reuse === "named") {
								// named policy with no name given: never reuse, always create new
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
								return {
									content: [{ type: "text", text: `Error: ${windows.length} windows open (max: ${currentSettings.maxWindows}). Clear idle windows first (/tmux:clear).` }],
									details: { windowCount: windows.length, max: currentSettings.maxWindows },
								};
							}
							if (silence) tryRun(`tmux set-option -t ${session} silence-action any`);
							windowIndex = createWindowWithCommand(session, windowCwd, params.command, windowName);
						}
					}

					// Start non-blocking completion tracking
					trackCompletion(pi, session, windowIndex, currentSettings.completionDelivery, currentSettings.completionTriggerTurn);

					// Wire silence detection if requested
					if (silence) registerSilence(session, windowIndex, silence);

					// Auto-attach
					let attachNote = "";
					if (flags.canAttach) {
						const autoFires =
							currentSettings.autoAttach === "always" ||
							(currentSettings.autoAttach === "session-create" && !alive);
						const shouldAttach = autoFires || params.attach === true;
						if (shouldAttach) {
							const mode = (params.mode as AttachLayout | undefined) ?? currentSettings.defaultLayout;
							try {
								attachNote = "\n" + attachToSession(ctx.cwd, { mode, tmuxWindow: windowIndex, piSessionId });
							} catch {
								attachNote = "\n(auto-attach failed — use /tmux attach)";
							}
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
						return { content: [{ type: "text", text: "Error: attach is disabled in settings. Use /tmux attach manually." }], details: {} };
					}
					if (!isSessionAlive(session)) {
						return { content: [{ type: "text", text: `No active session '${session}'.` }], details: {} };
					}
					const mode = (params.mode as AttachLayout | undefined) ?? currentSettings.defaultLayout;
					const targetWindow = typeof params.window === "number" ? params.window : undefined;
					const msg = attachToSession(ctx.cwd, { mode, tmuxWindow: targetWindow, piSessionId });
					return { content: [{ type: "text", text: msg }], details: {} };
				}

				case "focus": {
					if (!isSessionAlive(session)) {
						return { content: [{ type: "text", text: `No active session '${session}'.` }], details: {} };
					}
					const focusTarget = params.window ?? 0;
					const focusIdx = resolveWindow(session, focusTarget);
					if (focusIdx === undefined) {
						return { content: [{ type: "text", text: `No window '${focusTarget}' in session ${session}.` }], details: {} };
					}
					tryRun(`tmux select-window -t ${session}:${focusIdx}`);
					return { content: [{ type: "text", text: `Switched to :${focusIdx}` }], details: { session, window: focusIdx } };
				}

				case "close": {
					if (!isSessionAlive(session)) {
						return { content: [{ type: "text", text: `No active session '${session}'.` }], details: {} };
					}
					const closeTarget = params.window;
					if (closeTarget === undefined) {
						return { content: [{ type: "text", text: "Error: 'window' is required for close. Use kill to close the entire session." }], details: {} };
					}
					const closeIdx = resolveWindow(session, closeTarget);
					if (closeIdx === undefined) {
						return { content: [{ type: "text", text: `No window '${closeTarget}' in session ${session}.` }], details: {} };
					}
					tryRun(`tmux kill-window -t ${session}:${closeIdx}`);
					const remaining = isSessionAlive(session) ? listWindows(session).length : 0;
					return {
						content: [{ type: "text", text: remaining > 0 ? `Closed :${closeIdx}. ${remaining} window(s) remain.` : `Closed :${closeIdx}. Session ended.` }],
						details: { session, window: closeIdx, sessionEnded: remaining === 0 },
					};
				}

				case "peek": {
					if (!isSessionAlive(session)) {
						return { content: [{ type: "text", text: `No active session '${session}'.` }], details: {} };
					}
					const peekTarget =
						params.window === undefined || params.window === "all"
							? ("all" as const)
							: typeof params.window === "number"
								? params.window
								: parseInt(String(params.window), 10);
					const output = captureOutput(session, typeof peekTarget === "number" && Number.isNaN(peekTarget) ? "all" : peekTarget);
					return { content: [{ type: "text", text: output }], details: { session } };
				}

				case "list": {
					if (!isSessionAlive(session)) {
						return { content: [{ type: "text", text: `No active session '${session}'.` }], details: {} };
					}
					const windows = listWindows(session);
					const formatted = windows.map((w) => `  :${w.index}  ${w.title}${w.active ? "  (active)" : ""}`);
					return {
						content: [{ type: "text", text: `Session ${session} — ${windows.length} window(s)\n${formatted.join("\n")}` }],
						details: { session, windows },
					};
				}

				case "kill": {
					if (!isSessionAlive(session)) {
						return { content: [{ type: "text", text: `No active session '${session}'.` }], details: {} };
					}
					closeAttachedSessions(session);
					run(`tmux kill-session -t ${session}`);
					return { content: [{ type: "text", text: `Killed session ${session}.` }], details: {} };
				}

				case "mute": {
					if (!flags.canMute) {
						return { content: [{ type: "text", text: "Error: mute is disabled in settings." }], details: {} };
					}
					if (params.window === undefined || params.window === "all") {
						return { content: [{ type: "text", text: "Error: 'window' index required for mute." }], details: {} };
					}
					const muteIdx = typeof params.window === "number" ? params.window : parseInt(String(params.window), 10);
					if (Number.isNaN(muteIdx)) {
						return { content: [{ type: "text", text: `Error: invalid window index '${params.window}'.` }], details: {} };
					}
					clearSilenceForWindow(session, muteIdx);
					const windows = listWindows(session);
					const mutedWindow = windows.find((w) => w.index === muteIdx);
					return {
						content: [{ type: "text", text: `Muted silence alerts for "${mutedWindow?.title ?? `window ${muteIdx}`}" (:${muteIdx}).` }],
						details: {},
					};
				}

				default:
					return { content: [{ type: "text", text: `Unknown action: ${params.action}` }], details: {} };
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
