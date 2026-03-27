/**
 * /tmux command family — settings panel + operator subcommands.
 *
 * /tmux           Settings panel (or session info in non-interactive mode)
 * /tmux show      Session and window info
 * /tmux cat       Capture output into conversation
 * /tmux clear     Kill idle windows
 * /tmux kill      Kill session
 * /tmux attach    Attach (default layout)
 * /tmux tab       Attach as tab
 * /tmux split     Attach as vertical split
 * /tmux hsplit    Attach as horizontal split
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { AutoAttachMode, AttachLayout, TmuxSettings } from "./types.js";
import {
	saveSettings,
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

export function registerTmuxCommand(pi: ExtensionAPI, getPiSessionId: () => string | null): void {
	pi.registerCommand("tmux", {
		description: "Manage tmux session and settings",
		getArgumentCompletions(prefix) {
			const items = [
				{ value: "show", description: "Session and window info" },
				{ value: "cat", description: "Capture output into conversation" },
				{ value: "clear", description: "Kill idle windows" },
				{ value: "kill", description: "Kill session" },
				{ value: "attach", description: "Attach (default layout)" },
				{ value: "tab", description: "Attach as tab" },
				{ value: "split", description: "Attach as vertical split" },
				{ value: "hsplit", description: "Attach as horizontal split" },
			];
			const lp = (prefix ?? "").trimStart().toLowerCase();
			const filtered = items.filter((i) => i.value.startsWith(lp));
			return filtered.length > 0
				? filtered.map((i) => ({ value: i.value, label: `${i.value} - ${i.description}` }))
				: null;
		},
		handler: async (args, ctx) => {
			const sub = (args ?? "").trim().toLowerCase();
			const root = resolveProjectRoot(ctx.cwd);
			const session = deriveSessionName(root);

			// Attach variants
			const attachModes: Record<string, AttachLayout> = {
				attach: currentSettings.defaultLayout,
				tab: "tab",
				split: "split-vertical",
				hsplit: "split-horizontal",
			};
			if (sub in attachModes) {
				const layout = attachModes[sub];
				if (!layout) return;
				const msg = attachToSession(ctx.cwd, { mode: layout, piSessionId: getPiSessionId() });
				ctx.ui.notify(msg, msg.startsWith("Failed") || msg.startsWith("No") ? "error" : "info");
				return;
			}

			if (sub === "show") return handleShow(ctx, session);
			if (sub === "cat") return handleCat(ctx, pi, session);
			if (sub === "clear") return handleClear(ctx, session);
			if (sub === "kill") return handleKill(ctx, session);

			if (sub) {
				ctx.ui.notify(`Unknown: /tmux ${sub}`, "warning");
				return;
			}

			// No-arg: settings panel (or session summary in non-interactive)
			if (!ctx.hasUI) {
				handleShow(ctx, session);
				return;
			}

			await openSettingsPanel(ctx);
		},
	});
}

// ---------------------------------------------------------------------------
// Settings panel
// ---------------------------------------------------------------------------

async function openSettingsPanel(ctx: ExtensionCommandContext): Promise<void> {
	const { getSettingsListTheme } = await import("@mariozechner/pi-coding-agent");
	const { Container, SettingsList, Text: TuiText } = await import("@mariozechner/pi-tui");

	let changed = false;

	await ctx.ui.custom((_tui, theme, _kb, done) => {
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
				description: autoAttachTip(currentSettings.autoAttach),
				currentValue: currentSettings.autoAttach,
				values: [...AUTO_ATTACH_VALUES],
			},
			{
				id: "defaultLayout",
				label: "Default attach layout",
				description: layoutTip(currentSettings.defaultLayout),
				currentValue: currentSettings.defaultLayout,
				values: [...LAYOUT_VALUES],
			},
			{
				id: "allowMute",
				label: "Allow model to mute silence alerts",
				description: muteTip(currentSettings.allowMute),
				currentValue: currentSettings.allowMute ? "on" : "off",
				values: ["on", "off"],
			},
			{
				id: "maxWindows",
				label: "Max windows per session",
				description: `Model can open up to ${currentSettings.maxWindows} tmux windows`,
				currentValue: currentMax,
				values: maxValues,
			},
		];

		const container = new Container();
		container.addChild(new TuiText(theme.fg("accent", theme.bold("tmux settings")), 1, 0));
		container.addChild(
			new TuiText(theme.fg("dim", "Settings that affect tool capabilities require a reload to apply."), 1, 0),
		);

		const settingsList = new SettingsList(
			items,
			Math.min(items.length + 2, 15),
			getSettingsListTheme(),
			(id, newValue) => {
				changed = true;
				applySettingChange(id, newValue);
				saveSettings(currentSettings);
				updateDescription(items, id, newValue);
			},
			() => done(undefined),
			{ enableSearch: true },
		);

		container.addChild(settingsList);

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => settingsList.handleInput?.(data),
		};
	});

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
// Dynamic description tips per selected value
// ---------------------------------------------------------------------------

const AUTO_ATTACH_TIPS: Record<AutoAttachMode, string> = {
	never: "Attach action and params removed from the tool schema entirely",
	"session-create": "Only the first run that creates a session auto-attaches",
	always: "Every run with attach: true opens a visible pane",
};

const LAYOUT_TIPS: Record<AttachLayout, string> = {
	"split-vertical": "Opens a vertical split alongside the current pane",
	tab: "Opens a new terminal tab",
	"split-horizontal": "Opens a horizontal split below the current pane",
};

function autoAttachTip(value: AutoAttachMode): string {
	return AUTO_ATTACH_TIPS[value];
}

function layoutTip(value: AttachLayout): string {
	return LAYOUT_TIPS[value];
}

function muteTip(on: boolean): string {
	return on
		? "Model can suppress silence notifications for long-running commands"
		: "Silence notifications cannot be suppressed by the model";
}

interface MutableItem {
	id: string;
	description?: string;
}

function updateDescription(items: MutableItem[], id: string, newValue: string): void {
	const item = items.find((i) => i.id === id);
	if (!item) return;

	if (id === "autoAttach" && isAutoAttachMode(newValue)) {
		item.description = autoAttachTip(newValue);
	} else if (id === "defaultLayout" && isAttachLayout(newValue)) {
		item.description = layoutTip(newValue);
	} else if (id === "allowMute") {
		item.description = muteTip(newValue === "on");
	} else if (id === "maxWindows") {
		item.description = `Model can open up to ${newValue} tmux windows`;
	}
}

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

function handleShow(ctx: ExtensionCommandContext, session: string): void {
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
