/**
 * pi-tmux — tmux session management per project.
 *
 * Tool: tmux (run/peek/list/kill + attach/mute gated by settings)
 * Commands: /tmux (settings), /tmux attach|tab|split|cat|clear|show|kill|help
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { AttachLayout, FeatureFlags, SilenceConfig } from "./types.js";
import { loadSettings, getFlags } from "./settings.js";
import { run, tryRun, resolveProjectRoot, deriveSessionName, isSessionAlive, listWindows, captureOutput, tmuxEscape } from "./session.js";
import { getActiveiTermSession, attachToSession, closeAttachedSessions } from "./terminal.js";
import { initSignalDir, getSignalDir, startWatching, stopWatching, registerSilence, executeWithSignal, createWindowWithCommand, clearSilenceForWindow } from "./signals.js";
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

	// --- Lifecycle ---

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

	// --- Command ---

	registerTmuxCommand(pi, () => piSessionId);

	// --- Tool (schema built from feature flags at load time) ---

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
					if (!params.name) {
						return {
							content: [{ type: "text", text: "Error: 'name' is required. Provide a unique window name (e.g. 'dev-server')." }],
							details: {},
						};
					}

					const windowName = params.name.slice(0, 30);
					const alive = isSessionAlive(session);

					if (alive) {
						const windows = listWindows(session);
						const dup = windows.find((w) => w.title === windowName);
						if (dup) {
							return {
								content: [{ type: "text", text: `Error: window '${windowName}' already exists (:${dup.index}). Choose a unique name or kill the existing window.` }],
								details: { existingWindow: dup.index },
							};
						}
						if (windows.length >= currentSettings.maxWindows) {
							return {
								content: [{ type: "text", text: `Error: ${windows.length} windows open (max: ${currentSettings.maxWindows}). Clear idle windows first (/tmux clear).` }],
								details: { windowCount: windows.length, max: currentSettings.maxWindows },
							};
						}
					}

					startWatching(pi);
					const dir = getSignalDir();
					const timeout = params.silenceTimeout ?? 0;
					const silence: SilenceConfig | undefined =
						timeout > 0 ? { timeout, factor: params.silenceBackoffFactor ?? 1.5, cap: params.silenceBackoffCap ?? 300 } : undefined;
					const windowCwd = params.cwd ?? root;

					let windowIndex: number;
					let runId: string;

					if (!alive) {
						run(`tmux new-session -d -s ${session} -n "${tmuxEscape(windowName)}" -c "${windowCwd}"`);
						run(`tmux set-option -t ${session} silence-action any`);
						runId = executeWithSignal(dir, session, 0, params.command, silence);
						windowIndex = 0;
					} else {
						if (silence) tryRun(`tmux set-option -t ${session} silence-action any`);
						const result = createWindowWithCommand(dir, session, windowCwd, params.command, windowName, silence);
						windowIndex = result.index;
						runId = result.runId;
					}

					if (silence) registerSilence(session, windowIndex, runId, silence);

					// Auto-attach gated by user settings
					let attachNote = "";
					if (flags.canAttach && params.attach) {
						const shouldAttach = currentSettings.autoAttach === "always" || (currentSettings.autoAttach === "session-create" && !alive);
						if (shouldAttach) {
							const mode = (params.mode as AttachLayout | undefined) ?? currentSettings.defaultLayout;
							try {
								attachNote = "\n" + attachToSession(ctx.cwd, { mode, tmuxWindow: windowIndex, piSessionId });
							} catch {
								attachNote = "\n(auto-attach failed — use /tmux attach)";
							}
						}
					}

					return {
						content: [{ type: "text", text: `${alive ? "Added to" : "Created"} session ${session}\n  :${windowIndex}  ${windowName}: ${params.command}${attachNote}` }],
						details: { session, windowIndex, created: !alive },
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

	// --- Custom message renderers ---

	pi.registerMessageRenderer("tmux-completion", (message, { expanded }, theme) => {
		const raw = message.content as string;
		const [summary, ...rest] = raw.split("\n");
		const icon = (summary ?? "").includes("successfully") ? theme.fg("success", "*") : theme.fg("error", "x");
		let text = `${icon} ${theme.fg("toolTitle", "tmux")} ${summary ?? ""}`;
		if (expanded && rest.length > 0) text += "\n" + theme.fg("dim", rest.join("\n"));
		return new Text(text, 0, 0);
	});

	pi.registerMessageRenderer("tmux-silence", (message, { expanded }, theme) => {
		const raw = message.content as string;
		const [summary, ...rest] = raw.split("\n");
		let text = `${theme.fg("warning", "||")} ${theme.fg("toolTitle", "tmux")} ${summary ?? ""}`;
		if (expanded && rest.length > 0) text += "\n" + theme.fg("dim", rest.join("\n"));
		return new Text(text, 0, 0);
	});
}
