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

		command: Type.Optional(Type.String({ description: "Command to execute (for 'run' action)." })),
		name: Type.Optional(
			Type.String({
				description:
					"Window name for 'run'. Optional — omit to reuse the last idle window (default) or auto-name from the command. Provide a name to target a specific window by name. E.g. 'dev-server', 'test-suite'.",
			}),
		),
		cwd: Type.Optional(
			Type.String({
				description: "Working directory for the command (for 'run' action). Defaults to project root (git root or pi's cwd).",
			}),
		),

		silenceTimeout: Type.Optional(
			Type.Number({
				description: "Seconds of inactivity before a silence notification fires (for 'run' action). 0 or omit to disable. Default 60.",
			}),
		),
		silenceBackoffFactor: Type.Optional(
			Type.Number({ description: "Multiplier applied to the silence interval after each notification (for 'run' action). Default 1.5." }),
		),
		silenceBackoffCap: Type.Optional(
			Type.Number({ description: "Upper bound for the silence interval in seconds (for 'run' action). Default 300 (5 min)." }),
		),

		window: Type.Optional(
			Type.Union([Type.Number(), Type.String()], {
				description: "Target window index, or 'all' (for 'peek'/'mute' actions). Defaults to 'all' for peek.",
			}),
		),

		...(flags.canAttach
			? {
					attach: Type.Optional(
						Type.Boolean({
							description:
								"For 'run' action: request a visible terminal pane attached to the new window. Honored only when the user's auto-attach setting allows it. Default false.",
						}),
					),
					mode: Type.Optional(
						Type.String({
							description: "Terminal layout for 'attach' action: 'split-vertical' (default), 'tab', or 'split-horizontal'.",
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
		"WHEN TO USE: Use this instead of bash for anything that runs longer than a few seconds or runs in the background — dev servers, watchers, builds, test suites. Use bash for quick commands that return immediately (ls, grep, git status).",
		"",
		"Actions:",
		...when(
			flags.canAttach,
			"- run: Start a command in a named tmux window. Completion and exit code are reported automatically. Set 'attach: true' to open a visible pane (subject to the user's auto-attach setting).",
			"- attach: Open a terminal view into the session for the user to interact with. Supports window targeting via 'window' param.",
		),
		...when(
			!flags.canAttach,
			"- run: Start a command in a named tmux window. Completion and exit code are reported automatically.",
		),
		"- peek: Read recent output from one or all windows without attaching.",
		"- list: Show all windows in the session with their status.",
		"- kill: Terminate the entire session and close any attached panes.",
		...when(flags.canMute, "- mute: Disable silence notifications for a specific window index. Use only for commands with expected long idle periods, not for interactive processes."),
		"",
		...when(flags.canAttach, "The user manages attachment via /tmux attach|tab|split|hsplit and controls auto-attach behavior in /tmux settings."),
		...when(!flags.canAttach, "Attachment is disabled in user settings. The user can re-enable it via /tmux settings."),
	].join("\n");
}

export function buildPromptSnippet(flags: FeatureFlags): string {
	return [
		"Manage a tmux session for the current project (one session per git root or working directory).",
		"Use for long-running or background commands instead of bash.",
		...when(flags.canAttach, "Set 'attach: true' when the user wants to see or interact with output."),
	].join(" ");
}

export function buildPromptGuidelines(flags: FeatureFlags): string[] {
	return [
		"Use tmux for commands that take more than a few seconds or run continuously. Use bash for quick one-shot commands that return immediately.",
		"After 'run', move on to other work. The extension notifies you automatically when the command finishes with exit code and recent output. Use 'peek' to check intermediate progress.",
		...when(
			flags.canAttach,
			"Set 'attach: true' on the run call when the user explicitly asks to see tmux output or interact with a running process. The user's auto-attach setting controls whether this actually opens a pane.",
		),
		"Use silenceTimeout when a command might prompt for input (installers, confirmations, interactive tools). Defaults: 60s initial, 1.5x backoff, 5 min cap.",
		"Do not kill sessions unless explicitly asked — session history is useful for later inspection via peek.",
		"Omit 'name' to reuse the last idle window automatically (default). Provide 'name' to target a specific named window.",
		...when(flags.canMute, "Only mute windows running commands with expected long idle periods (large builds, background daemons). Never mute interactive or input-waiting processes."),
	];
}
