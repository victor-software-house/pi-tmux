/**
 * pi-tmux — tmux session management per project.
 *
 * Tool: tmux (run/peek/list/kill + attach/mute gated by settings)
 * Commands: /tmux (settings), /tmux attach|tab|split|cat|clear|show|kill|help
 *
 * Completion notifications: commands are wrapped so that when they finish,
 * a signal file is written. A fs.watch picks it up and injects a message
 * into the conversation with the exit code and recent output.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { AttachLayout, FeatureFlags, SilenceConfig } from "./types.js";
import { loadSettings, getFlags } from "./settings.js";
import { exec, execSafe, getProjectRoot, sessionName, sessionExists, getWindows, escapeForTmux } from "./session.js";
import { getActiveiTermSession, attachToSession, closeAttachedSessions } from "./terminal.js";
import { initSignalDir, getSignalDir, startWatching, stopWatching, registerSilence, sendCommandWithSignal, addWindow, clearSilenceForWindow } from "./signals.js";
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

	// Share settings with command module
	initCommandSettings(currentSettings);

	pi.on("session_start", async (_event, ctx) => {
		capturePiSession();
		currentSettings = loadSettings();
		initCommandSettings(currentSettings);
		initSignalDir(ctx.sessionManager.getSessionFile());
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
		await stopWatching();
	});

	// Register /tmux command family
	registerTmuxCommand(pi, () => piSessionId);

	// Register tool — schema built from feature flags at load time.
	// Settings changes prompt /reload, which re-runs this and rebuilds the schema.
	const flags: FeatureFlags = getFlags(currentSettings);

	pi.registerTool({
		name: "tmux",
		label: "tmux",
		description: buildDescription(flags),
		promptSnippet: buildPromptSnippet(flags),
		promptGuidelines: buildPromptGuidelines(flags),
		parameters: buildParams(flags),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const projectRoot = getProjectRoot(ctx.cwd);
			const session = sessionName(projectRoot);

			switch (params.action) {
				case "run": {
					if (!params.command) {
						return { content: [{ type: "text", text: "Error: 'command' required for run action." }], details: {} };
					}
					if (!params.name) {
						return {
							content: [
								{
									type: "text",
									text: "Error: 'name' required for run action. Provide a short unique name for the window (e.g. 'dev-server', 'test-suite').",
								},
							],
							details: {},
						};
					}

					const winName = params.name.slice(0, 30);
					const exists = sessionExists(session);

					if (exists) {
						const windows = getWindows(session);
						const duplicate = windows.find((w) => w.title === winName);
						if (duplicate) {
							return {
								content: [
									{
										type: "text",
										text: `Error: window name '${winName}' already exists in session (:${duplicate.index}). Use a unique name, or peek/kill the existing window first.`,
									},
								],
								details: { existingWindow: duplicate.index },
							};
						}
						if (windows.length >= currentSettings.maxWindows) {
							return {
								content: [
									{
										type: "text",
										text: `Error: session has ${windows.length} windows (max: ${currentSettings.maxWindows}). Kill or clear idle windows first. Use /tmux clear or kill specific windows.`,
									},
								],
								details: { windowCount: windows.length, maxWindows: currentSettings.maxWindows },
							};
						}
					}

					startWatching(pi);

					const signalDir = getSignalDir();
					const timeout = params.silenceTimeout ?? 0;
					const silence: SilenceConfig | undefined =
						timeout > 0 ? { timeout, factor: params.silenceBackoffFactor ?? 1.5, cap: params.silenceBackoffCap ?? 300 } : undefined;
					const windowCwd = params.cwd ?? projectRoot;
					let windowIndex: number;
					let windowId: string;

					if (!exists) {
						exec(`tmux new-session -d -s ${session} -n "${escapeForTmux(winName)}" -c "${windowCwd}"`);
						exec(`tmux set-option -t ${session} silence-action any`);
						windowId = sendCommandWithSignal(signalDir, session, 0, params.command, silence);
						windowIndex = 0;
					} else {
						if (silence) {
							execSafe(`tmux set-option -t ${session} silence-action any`);
						}
						const result = addWindow(signalDir, session, windowCwd, params.command, winName, silence);
						windowIndex = result.index;
						windowId = result.id;
					}

					if (silence) {
						registerSilence(session, windowIndex, windowId, silence);
					}

					// Auto-attach — gated by user setting
					let attachMsg = "";
					if (flags.canAttach && params.attach) {
						const shouldAttach =
							currentSettings.autoAttach === "always" || (currentSettings.autoAttach === "session-create" && !exists);
						if (shouldAttach) {
							const mode = (params.mode as AttachLayout | undefined) ?? currentSettings.defaultLayout;
							try {
								attachMsg = "\n" + attachToSession(ctx.cwd, { mode, tmuxWindow: windowIndex, piSessionId });
							} catch {
								attachMsg = "\n(auto-attach failed — use /tmux attach)";
							}
						}
					}

					const label = params.name ? `${params.name}: ` : "";
					return {
						content: [
							{
								type: "text",
								text: `${exists ? "Added to" : "Created"} session ${session}\n  :${windowIndex}  ${label}${params.command}${attachMsg}`,
							},
						],
						details: { session, existed: exists, windowIndex },
					};
				}

				case "attach": {
					if (!flags.canAttach) {
						return {
							content: [{ type: "text", text: "Error: attach is disabled. User can attach manually via /tmux attach." }],
							details: {},
						};
					}
					if (!sessionExists(session)) {
						return { content: [{ type: "text", text: `No session '${session}' to attach to.` }], details: {} };
					}

					const attachMode = (params.mode as AttachLayout | undefined) ?? currentSettings.defaultLayout;
					const attachWindow = typeof params.window === "number" ? params.window : undefined;
					const msg = attachToSession(ctx.cwd, { mode: attachMode, tmuxWindow: attachWindow, piSessionId });
					return { content: [{ type: "text", text: msg }], details: {} };
				}

				case "peek": {
					if (!sessionExists(session)) {
						return { content: [{ type: "text", text: `No session '${session}'.` }], details: {} };
					}

					const win =
						params.window === undefined || params.window === "all"
							? ("all" as const)
							: typeof params.window === "number"
								? params.window
								: parseInt(params.window);

					const { capturePanes } = await import("./session.js");
					const output = capturePanes(session, typeof win === "string" ? win : isNaN(win as number) ? "all" : win);
					return { content: [{ type: "text", text: output }], details: { session } };
				}

				case "list": {
					if (!sessionExists(session)) {
						return { content: [{ type: "text", text: `No session '${session}'.` }], details: {} };
					}
					const windows = getWindows(session);
					const lines = windows.map((w) => `  :${w.index}  ${w.title}${w.active ? "  (active)" : ""}`);
					return {
						content: [{ type: "text", text: `Session ${session} — ${windows.length} window(s)\n${lines.join("\n")}` }],
						details: { session, windows },
					};
				}

				case "kill": {
					if (!sessionExists(session)) {
						return { content: [{ type: "text", text: `No session '${session}' to kill.` }], details: {} };
					}
					closeAttachedSessions(session);
					exec(`tmux kill-session -t ${session}`);
					return { content: [{ type: "text", text: `Killed session ${session}.` }], details: {} };
				}

				case "mute": {
					if (!flags.canMute) {
						return { content: [{ type: "text", text: "Error: mute is disabled in settings." }], details: {} };
					}

					const win = params.window;
					if (win === undefined || win === "all") {
						return { content: [{ type: "text", text: "Error: 'window' (index) required for mute action." }], details: {} };
					}

					const winIdx = typeof win === "number" ? win : parseInt(win);
					if (isNaN(winIdx)) {
						return { content: [{ type: "text", text: `Error: invalid window index '${win}'.` }], details: {} };
					}

					clearSilenceForWindow(session, winIdx);

					const windows = getWindows(session);
					const w = windows.find((w) => w.index === winIdx);
					const winName = w?.title ?? `window ${winIdx}`;

					return {
						content: [{ type: "text", text: `Muted silence notifications for "${winName}" (:${winIdx}).` }],
						details: {},
					};
				}

				default:
					return { content: [{ type: "text", text: `Unknown action: ${params.action}` }], details: {} };
			}
		},

		renderCall(args, theme) {
			const action = args.action ?? "tmux";
			let text = theme.fg("toolTitle", theme.bold("tmux "));
			text += theme.fg("accent", action);

			if (action === "run" && args.command) {
				const label = args.name ? theme.fg("text", args.name + ": ") : "";
				text += "\n  " + label + theme.fg("muted", args.command);
			} else if (action === "attach" && args.mode && args.mode !== "split-vertical") {
				text += theme.fg("muted", ` (${args.mode})`);
			} else if (action === "peek" && args.window !== undefined) {
				text += theme.fg("muted", ` :${args.window}`);
			}

			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const content = result.content?.[0];
			const raw = content?.type === "text" ? content.text : "";

			if (raw.startsWith("Error:") || raw.startsWith("Failed")) {
				return new Text(theme.fg("error", raw), 0, 0);
			}

			const lines = raw.split("\n");
			const summary = lines[0] ?? "";
			const detail = lines.slice(1).join("\n");

			let text = theme.fg("success", "* ") + summary;
			if (expanded && detail) {
				text += "\n" + theme.fg("dim", detail);
			}

			return new Text(text, 0, 0);
		},
	});

	// Custom renderers for completion and silence notifications
	pi.registerMessageRenderer("tmux-completion", (message, { expanded }, theme) => {
		const lines = (message.content as string).split("\n");
		const summary = lines[0] ?? "";
		const detail = lines.slice(1).join("\n");

		const icon = summary.includes("successfully") ? theme.fg("success", "*") : theme.fg("error", "x");
		let text = `${icon} ${theme.fg("toolTitle", "tmux")} ${summary}`;
		if (expanded && detail) {
			text += "\n" + theme.fg("dim", detail);
		}
		return new Text(text, 0, 0);
	});

	pi.registerMessageRenderer("tmux-silence", (message, { expanded }, theme) => {
		const lines = (message.content as string).split("\n");
		const summary = lines[0] ?? "";
		const detail = lines.slice(1).join("\n");

		let text = `${theme.fg("warning", "||")} ${theme.fg("toolTitle", "tmux")} ${summary}`;
		if (expanded && detail) {
			text += "\n" + theme.fg("dim", detail);
		}
		return new Text(text, 0, 0);
	});
}
