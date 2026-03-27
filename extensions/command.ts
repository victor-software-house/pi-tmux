/**
 * /tmux command family — settings panel + operator subcommands.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { AutoAttachMode, AttachLayout, TmuxSettings } from "./types.js";
import { saveSettings, AUTO_ATTACH_VALUES, LAYOUT_VALUES, MAX_WINDOWS_RANGE } from "./settings.js";
import { run, tryRun, resolveProjectRoot, deriveSessionName, isSessionAlive, listWindows, captureOutput } from "./session.js";
import { attachToSession, closeAttachedSessions } from "./terminal.js";

let currentSettings: TmuxSettings;

export function initCommandSettings(settings: TmuxSettings): void {
	currentSettings = settings;
}

const SUBCOMMANDS = ["attach", "tab", "split", "hsplit", "show", "cat", "clear", "kill", "help"];

export function registerTmuxCommand(pi: ExtensionAPI, getPiSessionId: () => string | null): void {
	pi.registerCommand("tmux", {
		description: "Manage tmux session. /tmux opens settings. /tmux attach|tab|split|hsplit|show|cat|clear|kill|help",
		getArgumentCompletions(prefix) {
			const lp = (prefix ?? "").toLowerCase();
			const matches = SUBCOMMANDS.filter((s) => s.startsWith(lp));
			return matches.length > 0 ? matches.map((s) => ({ label: s, value: s })) : null;
		},
		handler: async (args, ctx) => {
			const sub = (args ?? "").trim().toLowerCase();
			const root = resolveProjectRoot(ctx.cwd);
			const session = deriveSessionName(root);

			if (!sub) return showSettingsPanel(ctx);

			const attachModes: Record<string, AttachLayout> = {
				attach: currentSettings.defaultLayout,
				tab: "tab",
				split: "split-vertical",
				hsplit: "split-horizontal",
			};
			if (sub in attachModes) {
				const msg = attachToSession(ctx.cwd, { mode: attachModes[sub], piSessionId: getPiSessionId() });
				ctx.ui.notify(msg, msg.startsWith("Failed") || msg.startsWith("No") ? "error" : "info");
				return;
			}

			if (sub === "show") return handleShow(ctx, session);
			if (sub === "cat") return handleCat(ctx, pi, session);
			if (sub === "clear") return handleClear(ctx, session);
			if (sub === "kill") return handleKill(ctx, session);
			if (sub === "help") return handleHelp(ctx);

			ctx.ui.notify(`Unknown: /tmux ${sub}. Try /tmux help`, "warning");
		},
	});
}

// ---------------------------------------------------------------------------
// Settings panel
// ---------------------------------------------------------------------------

async function showSettingsPanel(ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		const lines = [
			`auto-attach: ${currentSettings.autoAttach}`,
			`default-layout: ${currentSettings.defaultLayout}`,
			`allow-mute: ${currentSettings.allowMute}`,
			`max-windows: ${currentSettings.maxWindows}`,
		];
		ctx.ui.notify(lines.join("\n"), "info");
		return;
	}

	const { DynamicBorder, getSettingsListTheme, rawKeyHint } = await import("@mariozechner/pi-coding-agent");
	const { Container, SettingsList, Spacer, Text: TuiText } = await import("@mariozechner/pi-tui");

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
		container.addChild(new Spacer(1));

		const settingsList = new SettingsList(items, 10, getSettingsListTheme(), (id, newValue) => {
			changed = true;
			if (id === "autoAttach" && AUTO_ATTACH_VALUES.includes(newValue as AutoAttachMode)) {
				currentSettings.autoAttach = newValue as AutoAttachMode;
			} else if (id === "defaultLayout" && LAYOUT_VALUES.includes(newValue as AttachLayout)) {
				currentSettings.defaultLayout = newValue as AttachLayout;
			} else if (id === "allowMute") {
				currentSettings.allowMute = newValue === "on";
			} else if (id === "maxWindows") {
				const n = parseInt(newValue, 10);
				if (n >= MAX_WINDOWS_RANGE.min && n <= MAX_WINDOWS_RANGE.max) {
					currentSettings.maxWindows = n;
				}
			}
			saveSettings(currentSettings);
		}, () => done(undefined));

		container.addChild(settingsList);
		container.addChild(new Spacer(1));
		container.addChild(new DynamicBorder());

		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => { settingsList.handleInput?.(data); },
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

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

function handleShow(ctx: ExtensionCommandContext, session: string): void {
	if (!isSessionAlive(session)) {
		ctx.ui.notify("No tmux session for this project.", "info");
		return;
	}
	const windows = listWindows(session);
	const formatted = windows.map((w) => `  :${w.index}  ${w.title}${w.active ? "  (active)" : ""}`);
	ctx.ui.notify(`Session ${session} — ${windows.length} window(s)\n${formatted.join("\n")}`, "info");
}

async function handleCat(ctx: ExtensionCommandContext, pi: ExtensionAPI, session: string): Promise<void> {
	if (!isSessionAlive(session)) {
		ctx.ui.notify("No tmux session for this project.", "error");
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
		ctx.ui.notify("No tmux session for this project.", "error");
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
		remaining ? `Cleared ${idle.length} idle window(s).` : `Cleared ${idle.length} idle window(s) — session closed.`,
		"info",
	);
}

function handleKill(ctx: ExtensionCommandContext, session: string): void {
	if (!isSessionAlive(session)) {
		ctx.ui.notify("No tmux session to kill.", "info");
		return;
	}
	closeAttachedSessions(session);
	run(`tmux kill-session -t ${session}`);
	ctx.ui.notify(`Killed session ${session}.`, "info");
}

function handleHelp(ctx: ExtensionCommandContext): void {
	ctx.ui.notify(
		[
			"/tmux              Settings panel",
			"/tmux attach       Attach (default layout)",
			"/tmux tab          Attach as tab",
			"/tmux split        Attach as vertical split",
			"/tmux hsplit        Attach as horizontal split",
			"/tmux show         Session info",
			"/tmux cat          Capture output into conversation",
			"/tmux clear        Kill idle windows",
			"/tmux kill         Kill session",
			"/tmux help         This help",
		].join("\n"),
		"info",
	);
}
