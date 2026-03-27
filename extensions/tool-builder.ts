/**
 * Dynamic tool schema builder — constructs params, description, and prompts
 * based on feature flags derived from user settings.
 */
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import type { FeatureFlags } from "./types.js";
import { when } from "./settings.js";

export function buildActions(flags: FeatureFlags): string[] {
	return ["run", ...when(flags.canAttach, "attach"), "peek", "list", "kill", ...when(flags.canMute, "mute")];
}

export function buildParams(flags: FeatureFlags) {
	return Type.Object({
		action: StringEnum(buildActions(flags) as [string, ...string[]]),

		command: Type.Optional(Type.String({ description: "Command to run (for 'run' action)." })),
		name: Type.Optional(
			Type.String({
				description:
					"Short descriptive name for the tmux window (for 'run' action). REQUIRED for 'run'. Must be unique within the session. E.g. 'dev-server', 'test-suite'.",
			}),
		),
		cwd: Type.Optional(
			Type.String({
				description: "Working directory for the command (for 'run' action). Defaults to project root (git root or pi's cwd).",
			}),
		),

		silenceTimeout: Type.Optional(
			Type.Number({
				description:
					"Seconds of silence before notifying that the command may be waiting for input (for 'run' action). Omit or 0 to disable. Default 60.",
			}),
		),
		silenceBackoffFactor: Type.Optional(
			Type.Number({ description: "Multiply silence interval after each notification (for 'run' action). Default 1.5." }),
		),
		silenceBackoffCap: Type.Optional(
			Type.Number({ description: "Max silence interval in seconds (for 'run' action). Default 300 (5 min)." }),
		),

		window: Type.Optional(
			Type.Union([Type.Number(), Type.String()], {
				description: "Window index or 'all' (for 'peek' action). Defaults to 'all'.",
			}),
		),

		...(flags.canAttach
			? {
					attach: Type.Optional(
						Type.Boolean({
							description:
								"For 'run' action: auto-attach a terminal split pane so the user sees output live. Default false. Set to true when the user explicitly asks to see tmux output or asks to 'use tmux'.",
						}),
					),
					mode: Type.Optional(
						Type.String({
							description:
								"How to open the terminal for 'attach' action: 'split-vertical' (default), 'tab', or 'split-horizontal'.",
						}),
					),
				}
			: {}),
	});
}

export function buildDescription(flags: FeatureFlags): string {
	return [
		"Manage a tmux session for the current project (one session per git root or working directory).",
		"",
		"WHEN TO USE: Prefer this over bash for long-running or background commands: dev servers, file watchers, build processes, test suites, anything that runs continuously or takes more than a few seconds. Use bash for quick one-shot commands that complete immediately (ls, cat, grep, git status, etc.).",
		"",
		"Actions:",
		...when(
			flags.canAttach,
			"- run: Run a command in a new tmux window. When the command finishes, the agent is notified with the exit code and recent output. Use 'attach: true' to auto-open a split pane (controlled by user's auto-attach setting).",
			"- attach: Open a terminal view attached to the session. Use 'mode' for layout and 'window' to target a specific window.",
		),
		...when(
			!flags.canAttach,
			"- run: Run a command in a new tmux window. When the command finishes, the agent is notified with the exit code and recent output.",
		),
		"- peek: Capture recent output from tmux windows. Use window param to target a specific window, or omit for all.",
		"- list: List all windows in the session.",
		"- kill: Kill the entire session.",
		...when(flags.canMute, "- mute: Suppress silence notifications for a window (requires window index). Use sparingly, only for expected long silences."),
		"",
		...when(
			flags.canAttach,
			"The user can also type /tmux to open settings, /tmux attach to open a terminal split, /tmux tab to open in a new tab, or /tmux cat to bring output into the conversation.",
		),
		...when(!flags.canAttach, "The user can type /tmux to open settings, or /tmux cat to bring output into the conversation."),
	].join("\n");
}

export function buildPromptSnippet(flags: FeatureFlags): string {
	return [
		"Manage a tmux session for the current project (one session per git root or working directory).",
		"Prefer this over bash for long-running or background commands.",
		...when(flags.canAttach, "Use 'attach: true' when the user wants to see or interact with the output."),
	].join(" ");
}

export function buildPromptGuidelines(flags: FeatureFlags): string[] {
	return [
		"Prefer tmux over bash for long-running or background commands: dev servers, file watchers, build processes, test suites, anything that runs continuously or takes more than a few seconds. Use bash for quick one-shot commands that complete immediately (ls, cat, grep, git status, etc.).",
		"After using tmux 'run', you do not need to poll or wait to find out when a command finishes. The session will automatically notify you with the exit code and recent output when the command completes — just move on to other work. You can still peek at any time to check intermediate output from a running process.",
		...when(
			flags.canAttach,
			"When the user explicitly asks to 'use tmux', 'show me in tmux', or wants to see commands running, use 'attach: true' on the run call to auto-open a visible split pane. Also call 'attach' after run when the user wants to interact with the terminal.",
		),
		"For commands that might prompt for input (installers, interactive tools, confirmations), use silenceTimeout to get notified when the command goes quiet. Defaults: 60s initial, 1.5x backoff factor, 5min cap.",
		"NEVER kill tmux sessions unnecessarily — preserve history for later inspection via 'peek'. Only kill when explicitly asked.",
		"Prefer sending commands to an existing window with tmux send-keys instead of creating new windows for every command. Avoid window proliferation.",
		...when(
			flags.canMute,
			"Use action 'mute' only when a command is expected to have long silence periods (build caches, large downloads). Do NOT mute commands that might be waiting for user input — silence notifications exist to catch those cases.",
		),
	];
}
