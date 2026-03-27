/**
 * /tmux command family — settings panel + operator subcommands.
 *
 * /tmux           Settings panel
 * /tmux show      Current settings summary
 * /tmux status    Session and window info
 * /tmux verify    Check tmux binary availability
 * /tmux path      Config file location
 * /tmux reset     Restore default settings
 * /tmux attach    Attach (default layout)
 * /tmux tab       Attach as tab
 * /tmux split     Attach as vertical split
 * /tmux hsplit    Attach as horizontal split
 * /tmux cat       Capture output into conversation
 * /tmux clear     Kill idle windows
 * /tmux kill      Kill session
 * /tmux help      Usage text
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";
import type { AutoAttachMode, AttachLayout, TmuxSettings } from "./types.js";
import {
	loadSettings,
	saveSettings,
	resetSettings,
	getConfigPath,
	AUTO_ATTACH_VALUES,
	LAYOUT_VALUES,
	MAX_WINDOWS_RANGE,
} from "./settings.js";
import { tryRun, resolveProjectRoot, deriveSessionName, isSessionAlive, listWindows, captureOutput } from "./session.js";
import { attachToSession, closeAttachedSessions } from "./terminal.js";

let currentSettings: TmuxSettings;

export function initCommandSettings(settings: TmuxSettings): void {
	currentSettings = settings;
}

const SUBCOMMANDS = [
	"show", "status", "verify", "path", "reset",
	"attach", "tab", "split", "hsplit",
	"cat", "clear", "kill", "help",
];

const USAGE_TEXT = [
	"Usage: /tmux [subcommand]",
	"  (none)   Settings panel",
	"  show     Current settings",
	"  status   Session and window info",
	"  verify   Check tmux binary",
	"  path     Config file location",
	"  reset    Restore defaults",
	"  attach   Attach (default layout)",
	"  tab      Attach as tab",
	"  split    Vertical split",
	"  hsplit   Horizontal split",
	"  cat      Capture output into conversation",
	"  clear    Kill idle windows",
	"  kill     Kill session",
].join("\n");

function getSubcommandCompletions(prefix: string): AutocompleteItem[] | null {
	const lp = (prefix ?? "").trimStart().toLowerCase();
	const matches = SUBCOMMANDS.filter((s) => s.startsWith(lp));
	return matches.length > 0 ? matches.map((s) => ({ label: s, value: s })) : null;
}

export function registerTmuxCommand(pi: ExtensionAPI, getPiSessionId: () => string | null): void {
	pi.registerCommand("tmux", {
		description: "Inspect and configure the tmux session extension",
		getArgumentCompletions: getSubcommandCompletions,
		handler: async (args, ctx) => {
			if (await handleSubcommand(args, ctx, pi, getPiSessionId)) {
				return;
			}

			if (!ctx.hasUI) {
				handleShow(ctx);
				return;
			}

			await openSettingsPanel(ctx);
		},
	});
}

// ---------------------------------------------------------------------------
// Subcommand dispatch — returns true if a subcommand was handled
// ---------------------------------------------------------------------------

async function handleSubcommand(
	args: string,
	ctx: ExtensionCommandContext,
	pi: ExtensionAPI,
	getPiSessionId: () => string | null,
): Promise<boolean> {
	const sub = (args ?? "").trim().toLowerCase();
	if (!sub) return false;

	// Operator inspection commands (no state mutation, no session needed)

	if (sub === "show") {
		handleShow(ctx);
		return true;
	}

	if (sub === "verify") {
		handleVerify(ctx);
		return true;
	}

	if (sub === "path") {
		ctx.ui.notify(`tmux config: ${getConfigPath()}`, "info");
		return true;
	}

	if (sub === "reset") {
		resetSettings();
		currentSettings = loadSettings();
		ctx.ui.notify("tmux settings restored to defaults.", "info");
		return true;
	}

	if (sub === "help") {
		ctx.ui.notify(USAGE_TEXT, "info");
		return true;
	}

	// Attach variants

	const attachModes: Record<string, AttachLayout> = {
		attach: currentSettings.defaultLayout,
		tab: "tab",
		split: "split-vertical",
		hsplit: "split-horizontal",
	};
	if (sub in attachModes) {
		const layout = attachModes[sub];
		if (!layout) {
			ctx.ui.notify(USAGE_TEXT, "warning");
			return true;
		}
		const msg = attachToSession(ctx.cwd, { mode: layout, piSessionId: getPiSessionId() });
		ctx.ui.notify(msg, msg.startsWith("Failed") || msg.startsWith("No") ? "error" : "info");
		return true;
	}

	// Session-dependent commands

	const root = resolveProjectRoot(ctx.cwd);
	const session = deriveSessionName(root);

	if (sub === "status") {
		handleStatus(ctx, session);
		return true;
	}

	if (sub === "cat") {
		await handleCat(ctx, pi, session);
		return true;
	}

	if (sub === "clear") {
		handleClear(ctx, session);
		return true;
	}

	if (sub === "kill") {
		handleKill(ctx, session);
		return true;
	}

	// Unknown subcommand
	ctx.ui.notify(USAGE_TEXT, "warning");
	return true;
}

// ---------------------------------------------------------------------------
// Settings panel
// ---------------------------------------------------------------------------

async function openSettingsPanel(ctx: ExtensionCommandContext): Promise<void> {
	const { DynamicBorder, getSettingsListTheme, rawKeyHint } = await import("@mariozechner/pi-coding-agent");
	const { Container, SettingsList, Spacer, Text: TuiText } = await import("@mariozechner/pi-tui");

	let changed = false;

	await ctx.ui.custom(
		(tui, theme, _kb, done) => {
			const maxValues = Array.from({ length: 10 }, (_, i) => String((i + 1) * 5));
			const currentMax = String(currentSettings.maxWindows);
			if (!maxValues.includes(currentMax)) {
				maxValues.push(currentMax);
				maxValues.sort((a, b) => Number(a) - Number(b));
			}

			const items = [
				{
					id: "autoAttach",
					label: "Auto-attach on run",
					description: "never: removes attach from tool | session-create: first run only | always: every run",
					currentValue: currentSettings.autoAttach,
					values: [...AUTO_ATTACH_VALUES],
				},
				{
					id: "defaultLayout",
					label: "Default attach layout",
					description: "How new terminal panes open when attaching",
					currentValue: currentSettings.defaultLayout,
					values: [...LAYOUT_VALUES],
				},
				{
					id: "allowMute",
					label: "Allow model to mute silence alerts",
					description: "off: model cannot suppress silence notifications | on: model can mute expected long silences",
					currentValue: currentSettings.allowMute ? "on" : "off",
					values: ["on", "off"],
				},
				{
					id: "maxWindows",
					label: "Max windows per session",
					description: "Maximum number of tmux windows the model can create",
					currentValue: currentMax,
					values: maxValues,
				},
			];

			const sep = theme.fg("muted", " \u00b7 ");
			const hints = rawKeyHint("enter", "change") + sep + rawKeyHint("esc", "close");

			const container = new Container();
			container.addChild(new Spacer(1));
			container.addChild(new DynamicBorder());
			container.addChild(new Spacer(1));
			container.addChild(new TuiText(theme.fg("accent", theme.bold("tmux settings")) + "  " + hints, 1, 0));
			container.addChild(new TuiText(theme.fg("dim", getConfigPath()), 1, 0));
			container.addChild(new Spacer(1));

			const settingsList = new SettingsList(
				items,
				Math.min(items.length + 2, 15),
				getSettingsListTheme(),
				(id, newValue) => {
					changed = true;
					applySettingChange(id, newValue);
					saveSettings(currentSettings);
				},
				() => done(undefined),
				{ enableSearch: true },
			);

			container.addChild(settingsList);
			container.addChild(new Spacer(1));
			container.addChild(new DynamicBorder());

			return {
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					settingsList.handleInput?.(data);
					tui.requestRender();
				},
			};
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: 80,
				maxHeight: "85%",
				margin: 1,
			},
		},
	);

	if (changed) {
		const reload = await ctx.ui.confirm("Reload Required", "Settings changed. Reload pi to update tool capabilities?");
		if (reload) {
			await ctx.reload();
			return;
		}
		ctx.ui.notify("Settings saved. Use /reload to apply tool changes.", "info");
	}
}

function applySettingChange(id: string, newValue: string): void {
	if (id === "autoAttach" && isAutoAttachMode(newValue)) {
		currentSettings.autoAttach = newValue;
	} else if (id === "defaultLayout" && isAttachLayout(newValue)) {
		currentSettings.defaultLayout = newValue;
	} else if (id === "allowMute") {
		currentSettings.allowMute = newValue === "on";
	} else if (id === "maxWindows") {
		const n = parseInt(newValue, 10);
		if (!Number.isNaN(n) && n >= MAX_WINDOWS_RANGE.min && n <= MAX_WINDOWS_RANGE.max) {
			currentSettings.maxWindows = n;
		}
	}
}

function isAutoAttachMode(value: string): value is AutoAttachMode {
	return AUTO_ATTACH_VALUES.includes(value as AutoAttachMode);
}

function isAttachLayout(value: string): value is AttachLayout {
	return LAYOUT_VALUES.includes(value as AttachLayout);
}

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

function handleShow(ctx: ExtensionCommandContext): void {
	const lines = [
		`auto-attach: ${currentSettings.autoAttach}`,
		`default-layout: ${currentSettings.defaultLayout}`,
		`allow-mute: ${currentSettings.allowMute}`,
		`max-windows: ${currentSettings.maxWindows}`,
	];
	ctx.ui.notify(lines.join("\n"), "info");
}

function handleVerify(ctx: ExtensionCommandContext): void {
	const version = tryRun("tmux -V");
	if (version) {
		ctx.ui.notify(`tmux is available: ${version}`, "info");
	} else {
		ctx.ui.notify("tmux binary not found. Install tmux to use this extension.", "warning");
	}
}

function handleStatus(ctx: ExtensionCommandContext, session: string): void {
	if (!isSessionAlive(session)) {
		ctx.ui.notify(`No active session (expected: ${session}).`, "info");
		return;
	}
	const windows = listWindows(session);
	const formatted = windows.map((w) => `  :${w.index}  ${w.title}${w.active ? "  (active)" : ""}`);
	ctx.ui.notify(`Session ${session} -- ${windows.length} window(s)\n${formatted.join("\n")}`, "info");
}

async function handleCat(ctx: ExtensionCommandContext, pi: ExtensionAPI, session: string): Promise<void> {
	if (!isSessionAlive(session)) {
		ctx.ui.notify("No active session.", "error");
		return;
	}
	const windows = listWindows(session);
	if (windows.length === 0) {
		ctx.ui.notify("No windows in session.", "error");
		return;
	}

	const options = ["all windows", ...windows.map((w) => `:${w.index}  ${w.title}${w.active ? "  (active)" : ""}`)];
	const choice = await ctx.ui.select("Capture output from:", options);
	if (choice === undefined || choice === null) return;

	let target: number | "all";
	if (String(choice) === "0" || choice === "all windows") {
		target = "all";
	} else {
		const choiceIdx = typeof choice === "number" ? choice - 1 : options.indexOf(String(choice)) - 1;
		const selectedWindow = windows[choiceIdx];
		if (!selectedWindow) {
			ctx.ui.notify("Invalid selection.", "error");
			return;
		}
		target = selectedWindow.index;
	}

	const output = captureOutput(session, target);
	pi.sendUserMessage(`Here is the tmux output:\n\n\`\`\`\n${output}\n\`\`\``, { deliverAs: "followUp" });
}

function handleClear(ctx: ExtensionCommandContext, session: string): void {
	if (!isSessionAlive(session)) {
		ctx.ui.notify("No active session.", "error");
		return;
	}

	const idleShells = new Set(["bash", "zsh", "sh", "fish", "dash"]);
	const raw = tryRun(`tmux list-windows -t ${session} -F "#{window_index}\t#{pane_current_command}\t#{pane_pid}"`);
	if (!raw) {
		ctx.ui.notify("No windows in session.", "error");
		return;
	}

	const idle = raw
		.split("\n")
		.map((line) => {
			const parts = line.split("\t");
			return { index: parseInt(parts[0] ?? "0", 10), cmd: parts[1] ?? "", pid: parts[2] ?? "" };
		})
		.filter((w) => idleShells.has(w.cmd) && !tryRun(`pgrep -P ${w.pid}`));

	if (idle.length === 0) {
		ctx.ui.notify("No idle windows to clear.", "info");
		return;
	}

	for (const w of idle) {
		tryRun(`tmux kill-window -t ${session}:${w.index}`);
	}

	const remaining = isSessionAlive(session);
	ctx.ui.notify(
		remaining ? `Cleared ${idle.length} idle window(s).` : `Cleared ${idle.length} idle window(s) -- session closed.`,
		"info",
	);
}

function handleKill(ctx: ExtensionCommandContext, session: string): void {
	if (!isSessionAlive(session)) {
		ctx.ui.notify("No active session to kill.", "info");
		return;
	}
	closeAttachedSessions(session);
	tryRun(`tmux kill-session -t ${session}`);
	ctx.ui.notify(`Killed session ${session}.`, "info");
}
