/**
 * Dynamic tool schema builder — constructs params, description, and prompt
 * guidelines based on current feature flags. Every section is conditional so
 * disabled behaviours produce zero tokens.
 */
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import type { FeatureFlags } from "./types.js";
import { when } from "./settings.js";

export function buildActions(flags: FeatureFlags): string[] {
	return ["run", ...when(flags.canAttach, "attach"), "focus", "close", "peek", "list", "kill", ...when(flags.canMute, "mute")];
}

export function buildParams(flags: FeatureFlags) {
	const nameDesc =
		flags.windowReuse === "never"
			? "Window name for 'run'. Every run creates a new window. Auto-named from command when omitted."
			: flags.windowReuse === "named"
				? "Window name for 'run'. Providing a name reuses an existing idle window with that name. Omit to create a new auto-named window."
				: "Window name for 'run'. Omit to reuse the last idle window automatically. Provide a name to target a specific window by name.";

	return Type.Object({
		action: StringEnum(buildActions(flags) as [string, ...string[]]),

		// run params
		command: Type.Optional(Type.String({ description: "Command to run (for 'run' action)." })),
		name: Type.Optional(Type.String({ description: nameDesc })),
		cwd: Type.Optional(
			Type.String({ description: "Working directory (for 'run' action). Defaults to project root." }),
		),
		silenceTimeout: Type.Optional(
			Type.Number({ description: "Seconds of inactivity before a silence notification fires (for 'run'). 0 or omit to disable." }),
		),
		silenceBackoffFactor: Type.Optional(
			Type.Number({ description: "Silence interval multiplier after each notification. Default 1.5." }),
		),
		silenceBackoffCap: Type.Optional(
			Type.Number({ description: "Max silence interval in seconds. Default 300." }),
		),

		// targeting param — focus, close, peek, mute, attach
		window: Type.Optional(
			Type.Union([Type.Number(), Type.String()], {
				description: "Window index or name. Required for 'focus', 'close', and 'mute'. Optional for 'peek' (defaults to 'all') and 'attach'.",
			}),
		),

		// attach param
		mode: Type.Optional(
			Type.String({ description: "Terminal layout for 'attach': 'split-vertical' (default), 'tab', or 'split-horizontal'." }),
		),
	});
}

export function buildDescription(flags: FeatureFlags): string {
	const attachBehaviour =
		flags.autoAttach === "always"
			? "A terminal opens automatically for every run."
			: flags.autoAttach === "session-create"
				? "A terminal opens automatically when a new session is created."
				: null;

	return [
		"Manage a tmux session for the current project (one session per git root or working directory).",
		"",
		"WHEN TO USE: Use instead of bash for anything long-running or background — dev servers, watchers, builds, test suites. Use bash for quick commands (ls, grep, git status).",
		"",
		"Actions:",
		`- run: Start a command in a tmux window. Completion and exit code are reported automatically.${attachBehaviour ? `\n  ${attachBehaviour}` : ""}`,
		...when(flags.canAttach, "- attach: Open a terminal view into the session. Supports window targeting via 'window' param."),
		"- focus: Switch the attached terminal to a window by index or name without opening a new pane.",
		"- close: Close a specific window by index or name. Use kill to close the entire session.",
		"- peek: Read recent output from one or all windows.",
		"- list: Show all windows with their status.",
		"- kill: Terminate the entire session.",
		...when(flags.canMute, "- mute: Disable silence notifications for a specific window index."),
	].join("\n");
}

export function buildPromptSnippet(flags: FeatureFlags): string {
	const parts = ["Manage a tmux session for the current project. Use for long-running or background commands instead of bash."];
	if (flags.autoAttach === "always") {
		parts.push("A terminal opens automatically for every run.");
	} else if (flags.autoAttach === "session-create") {
		parts.push("A terminal opens automatically on new session creation.");
	}
	return parts.join(" ");
}

export function buildPromptGuidelines(flags: FeatureFlags): string[] {
	const reuseGuideline =
		flags.windowReuse === "never"
			? "Every run creates a new window. Use 'name' to label it."
			: flags.windowReuse === "named"
				? "Provide 'name' to reuse an existing idle window with that name. Omit for a new auto-named window."
				: "Omit 'name' to reuse the last idle window automatically (default). Provide 'name' to target a specific named window.";

	const attachGuideline =
		flags.autoAttach === "always"
			? "A terminal opens automatically for every run."
			: flags.autoAttach === "session-create"
				? "A terminal opens automatically when a new session is created."
				: null;

	return [
		"Use tmux for commands that take more than a few seconds or run continuously. Use bash for quick one-shot commands that return immediately.",
		"After 'run', move on — the extension notifies you automatically when the command finishes with exit code and recent output. Use 'peek' to check intermediate progress.",
		...(attachGuideline ? [attachGuideline] : []),
		reuseGuideline + " Explicitly named windows preserve scrollback history (send-keys). Auto-reused windows are respawned clean.",
		"Use silenceTimeout when a command might prompt for input. Defaults: 60s initial, 1.5x backoff, 5 min cap.",
		"Do not kill sessions unless explicitly asked.",
		...when(flags.canMute, "Only mute windows with expected long idle periods (large builds, background daemons). Never mute interactive processes."),
	];
}
