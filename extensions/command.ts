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
import type { AutoAttachMode, AttachLayout, AutoFocus, CompletionDelivery, TmuxSettings, WindowReuse } from "./types.js";
import {
	saveSettings,
	getConfigPath,
	AUTO_ATTACH_VALUES,
	LAYOUT_VALUES,
	WINDOW_REUSE_VALUES,
	AUTO_FOCUS_VALUES,
	COMPLETION_DELIVERY_VALUES,
	MAX_WINDOWS_RANGE,
} from "./settings.js";
import { resolveProjectRoot, deriveSessionName, isSessionAlive, listWindows, captureOutput } from "./session.js";
import { actionAttach, actionList, actionClear, actionKill, actionPeek, type ActionResult } from "./actions.js";

/** Route an ActionResult to the UI. */
function notify(ctx: ExtensionCommandContext, result: ActionResult): void {
	ctx.ui.notify(result.message, result.ok ? "info" : "error");
}

let currentSettings: TmuxSettings;

export function initCommandSettings(settings: TmuxSettings): void {
	currentSettings = settings;
}

export function registerTmuxCommand(pi: ExtensionAPI, getPiSessionId: () => string | null): void {
	pi.registerCommand("tmux", {
		description: "Manage tmux session and settings",
		getArgumentCompletions(prefix) {
			const subcommands = [
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
			const parts = lp.split(/\s+/);
			const sub = parts[0] ?? "";
			const rest = parts.slice(1).join(" ");

			// Subcommands that accept a window target
			const windowTargetSubs = new Set(["cat", "attach", "tab", "split", "hsplit"]);

			// If we have a recognized subcommand + space, offer window completions
			if (parts.length >= 2 && windowTargetSubs.has(sub)) {
				const root = resolveProjectRoot(process.cwd());
				const session = deriveSessionName(root);
				const windows = listWindows(session);
				if (windows.length === 0) return null;

				const windowItems = windows.map((w) => ({
					value: `${sub} :${w.index}`,
					label: `:${w.index}  ${w.title}${w.active ? "  (active)" : ""}`,
					description: w.title,
				}));

				const filtered = rest
					? windowItems.filter((i) => i.label.toLowerCase().includes(rest))
					: windowItems;
				return filtered.length > 0 ? filtered : null;
			}

			// First word — complete subcommands
			const filtered = subcommands.filter((i) => i.value.startsWith(lp));
			return filtered.length > 0
				? filtered.map((i) => ({ value: i.value, label: `${i.value} - ${i.description}` }))
				: null;
		},
		handler: async (args, ctx) => {
			const raw = (args ?? "").trim();
			const parts = raw.split(/\s+/);
			const sub = (parts[0] ?? "").toLowerCase();
			const windowArg = parseWindowArg(parts.slice(1).join(" "));
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
				notify(ctx, actionAttach(session, ctx.cwd, { layout, window: windowArg, piSessionId: getPiSessionId() }));
				return;
			}

			if (sub === "show") { notify(ctx, actionList(session)); return; }
			if (sub === "cat") return handleCat(ctx, pi, session, windowArg);
			if (sub === "clear") { notify(ctx, actionClear(session)); return; }
			if (sub === "kill") { notify(ctx, actionKill(session)); return; }

			if (sub) {
				ctx.ui.notify(`Unknown: /tmux ${sub}`, "warning");
				return;
			}

			// No-arg: settings panel (or session summary in non-interactive)
			if (!ctx.hasUI) {
				notify(ctx, actionList(session));
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

	await ctx.ui.custom((tui, theme, _kb, done) => {
			const maxValues = Array.from({ length: 10 }, (_, i) => String((i + 1) * 5));
			const currentMax = String(currentSettings.maxWindows);
			if (!maxValues.includes(currentMax)) {
				maxValues.push(currentMax);
				maxValues.sort((a, b) => Number(a) - Number(b));
			}

			const items = buildSettingItems(maxValues);

			const container = new Container();
			container.addChild(new TuiText(theme.fg("accent", theme.bold("tmux settings")), 1, 0));
			container.addChild(new TuiText(theme.fg("dim", getConfigPath()), 1, 0));

			const settingsList = new SettingsList(
				items,
				12,
				getSettingsListTheme(),
				(id, newValue) => {
					changed = true;
					applySettingChange(id, newValue);
					saveSettings(currentSettings);
					refreshDescriptions(items);
					tui.requestRender();
				},
				() => done(undefined),
				{ enableSearch: true },
			);

			container.addChild(settingsList);
			container.addChild(
				new TuiText(
					theme.fg("dim", "Esc: close | Arrow keys: navigate | Space: toggle | Reload to apply"),
					1,
					0,
				),
			);

			return {
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					settingsList.handleInput?.(data);
					tui.requestRender();
				},
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
	} else if (id === "windowReuse" && isWindowReuse(newValue)) {
		currentSettings.windowReuse = newValue;
	} else if (id === "autoFocus" && isAutoFocus(newValue)) {
		currentSettings.autoFocus = newValue;
	} else if (id === "completionDelivery" && isCompletionDelivery(newValue)) {
		currentSettings.completionDelivery = newValue;
	} else if (id === "completionTriggerTurn") {
		currentSettings.completionTriggerTurn = newValue === "on";
	}
}

function isAutoAttachMode(value: string): value is AutoAttachMode {
	return AUTO_ATTACH_VALUES.includes(value as AutoAttachMode);
}

function isAttachLayout(value: string): value is AttachLayout {
	return LAYOUT_VALUES.includes(value as AttachLayout);
}

function isWindowReuse(value: string): value is WindowReuse {
	return WINDOW_REUSE_VALUES.includes(value as WindowReuse);
}

function isAutoFocus(value: string): value is AutoFocus {
	return AUTO_FOCUS_VALUES.includes(value as AutoFocus);
}

function isCompletionDelivery(value: string): value is CompletionDelivery {
	return COMPLETION_DELIVERY_VALUES.includes(value as CompletionDelivery);
}

// ---------------------------------------------------------------------------
// Dynamic descriptions — lookup tables keyed by current value
// ---------------------------------------------------------------------------

const AUTO_ATTACH_DESCRIPTIONS: Record<string, string> = {
	never: "Never auto-attach; attach action and params removed from the tool schema",
	"session-create": "Auto-attach when a new session is created; model can also request attach: true",
	always: "Auto-attach on every run; model can also request attach: true",
};

const LAYOUT_DESCRIPTIONS: Record<string, string> = {
	"split-vertical": "Opens a vertical split alongside the current pane",
	tab: "Opens a new terminal tab",
	"split-horizontal": "Opens a horizontal split below the current pane",
};

const MUTE_DESCRIPTIONS: Record<string, string> = {
	on: "Model can suppress silence notifications for long-running commands",
	off: "Silence notifications cannot be suppressed by the model",
};

function autoAttachDescription(): string {
	return AUTO_ATTACH_DESCRIPTIONS[currentSettings.autoAttach] ?? "";
}

function layoutDescription(): string {
	return LAYOUT_DESCRIPTIONS[currentSettings.defaultLayout] ?? "";
}

function muteDescription(): string {
	return MUTE_DESCRIPTIONS[currentSettings.allowMute ? "on" : "off"] ?? "";
}

function maxWindowsDescription(): string {
	return `Model can open up to ${String(currentSettings.maxWindows)} tmux windows`;
}

const WINDOW_REUSE_DESCRIPTIONS: Record<string, string> = {
	last: "Reuse the last idle window when no name given; reuse matching named window otherwise",
	named: "Only reuse a window when a matching name is provided; always create new when unnamed",
	never: "Always create a new window for every run command",
};

const AUTO_FOCUS_DESCRIPTIONS: Record<string, string> = {
	always: "Switch attached terminal to the target window on every run",
	never: "Leave the active window unchanged when running commands",
};

function autoFocusDescription(): string {
	return AUTO_FOCUS_DESCRIPTIONS[currentSettings.autoFocus] ?? "";
}

const COMPLETION_DELIVERY_DESCRIPTIONS: Record<string, string> = {
	steer: "Interrupts the agent mid-turn with completion output (fastest)",
	followUp: "Waits for the current turn to finish, then triggers a new turn",
	nextTurn: "Queues silently until the next user message",
};

function completionDeliveryDescription(): string {
	return COMPLETION_DELIVERY_DESCRIPTIONS[currentSettings.completionDelivery] ?? "";
}

const COMPLETION_TRIGGER_TURN_DESCRIPTIONS: Record<string, string> = {
	on: "Wake the agent and start a new LLM turn when idle",
	off: "Append to history silently; agent only sees it on next turn",
};

function completionTriggerTurnDescription(): string {
	return COMPLETION_TRIGGER_TURN_DESCRIPTIONS[currentSettings.completionTriggerTurn ? "on" : "off"] ?? "";
}

function windowReuseDescription(): string {
	return WINDOW_REUSE_DESCRIPTIONS[currentSettings.windowReuse] ?? "";
}

interface MutableItem {
	id: string;
	description?: string;
}

function refreshDescriptions(items: MutableItem[]): void {
	for (const item of items) {
		switch (item.id) {
			case "autoAttach":
				item.description = autoAttachDescription();
				break;
			case "defaultLayout":
				item.description = layoutDescription();
				break;
			case "allowMute":
				item.description = muteDescription();
				break;
			case "maxWindows":
				item.description = maxWindowsDescription();
				break;
			case "windowReuse":
				item.description = windowReuseDescription();
				break;
			case "autoFocus":
				item.description = autoFocusDescription();
				break;
			case "completionDelivery":
				item.description = completionDeliveryDescription();
				break;
			case "completionTriggerTurn":
				item.description = completionTriggerTurnDescription();
				break;
		}
	}
}

function buildSettingItems(maxValues: string[]): MutableItem[] & { id: string; label: string; currentValue: string; values: string[]; description: string }[] {
	return [
		{
			id: "autoAttach",
			label: "Auto-attach on run",
			description: autoAttachDescription(),
			currentValue: currentSettings.autoAttach,
			values: [...AUTO_ATTACH_VALUES],
		},
		{
			id: "defaultLayout",
			label: "Default attach layout",
			description: layoutDescription(),
			currentValue: currentSettings.defaultLayout,
			values: [...LAYOUT_VALUES],
		},
		{
			id: "allowMute",
			label: "Allow model to mute silence alerts",
			description: muteDescription(),
			currentValue: currentSettings.allowMute ? "on" : "off",
			values: ["on", "off"],
		},
		{
			id: "maxWindows",
			label: "Max windows per session",
			description: maxWindowsDescription(),
			currentValue: String(currentSettings.maxWindows),
			values: maxValues,
		},
		{
			id: "windowReuse",
			label: "Window reuse",
			description: windowReuseDescription(),
			currentValue: currentSettings.windowReuse,
			values: [...WINDOW_REUSE_VALUES],
		},
		{
			id: "autoFocus",
			label: "Auto-focus window on run",
			description: autoFocusDescription(),
			currentValue: currentSettings.autoFocus,
			values: [...AUTO_FOCUS_VALUES],
		},
		{
			id: "completionDelivery",
			label: "Completion notification delivery",
			description: completionDeliveryDescription(),
			currentValue: currentSettings.completionDelivery,
			values: [...COMPLETION_DELIVERY_VALUES],
		},
		{
			id: "completionTriggerTurn",
			label: "Trigger agent turn on completion",
			description: completionTriggerTurnDescription(),
			currentValue: currentSettings.completionTriggerTurn ? "on" : "off",
			values: ["on", "off"],
		},
	];
}

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

/** Parse a window argument like ":2" or "2" into a window index. */
function parseWindowArg(raw: string): number | undefined {
	const trimmed = raw.trim().replace(/^:/, "");
	if (!trimmed) return undefined;
	const n = parseInt(trimmed, 10);
	return Number.isNaN(n) ? undefined : n;
}

async function handleCat(ctx: ExtensionCommandContext, pi: ExtensionAPI, session: string, windowArg?: number): Promise<void> {
	if (!isSessionAlive(session)) {
		ctx.ui.notify("No active session.", "error");
		return;
	}
	const windows = listWindows(session);
	if (windows.length === 0) {
		ctx.ui.notify("No windows in session.", "error");
		return;
	}

	let target: number | "all";

	if (windowArg !== undefined) {
		// Window provided via argument — use actionPeek for validation
		const result = actionPeek(session, windowArg);
		if (!result.ok) {
			ctx.ui.notify(result.message, "error");
			return;
		}
		target = windowArg;
	} else {
		// No window argument — show interactive picker
		const options = ["all windows", ...windows.map((w) => `:${w.index}  ${w.title}${w.active ? "  (active)" : ""}`)];
		const choice = await ctx.ui.select("Capture output from:", options);
		if (choice === undefined || choice === null) return;

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
	}

	const output = captureOutput(session, target);
	pi.sendUserMessage(`Here is the tmux output:\n\n\`\`\`\n${output}\n\`\`\``, { deliverAs: "followUp" });
}


