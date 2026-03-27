/**
 * /tmux command family — settings panel + operator subcommands.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { AutoAttachMode, AttachLayout, TmuxSettings } from "./types.js";
import { saveSettings, AUTO_ATTACH_VALUES, LAYOUT_VALUES, MAX_WINDOWS_RANGE } from "./settings.js";
import { exec, execSafe, getProjectRoot, sessionName, sessionExists, getWindows, capturePanes } from "./session.js";
import { attachToSession, closeAttachedSessions } from "./terminal.js";

let currentSettings: TmuxSettings;

export function initCommandSettings(settings: TmuxSettings): void {
	currentSettings = settings;
}

const TMUX_SUBCOMMANDS = ["attach", "tab", "split", "hsplit", "show", "cat", "clear", "kill", "help"];

export function registerTmuxCommand(pi: ExtensionAPI, getPiSessionId: () => string | null): void {
	pi.registerCommand("tmux", {
		description: "Manage tmux session. /tmux opens settings. /tmux attach|tab|split|hsplit|show|cat|clear|kill|help",
		getArgumentCompletions(prefix) {
			const lp = (prefix ?? "").toLowerCase();
			const matches = TMUX_SUBCOMMANDS.filter((s) => s.startsWith(lp));
			return matches.length > 0 ? matches.map((s) => ({ label: s, value: s })) : null;
		},
		handler: async (args, ctx) => {
			const sub = (args ?? "").trim().toLowerCase();
			const projectRoot = getProjectRoot(ctx.cwd);
			const session = sessionName(projectRoot);

			if (!sub) {
				await showSettingsPanel(ctx, pi);
				return;
			}

			const attachModes: Record<string, AttachLayout> = {
				attach: currentSettings.defaultLayout,
				tab: "tab",
				split: "split-vertical",
				hsplit: "split-horizontal",
			};
			if (sub in attachModes) {
				const piSessionId = getPiSessionId();
				const msg = attachToSession(ctx.cwd, { mode: attachModes[sub], piSessionId });
				ctx.ui.notify(msg, msg.startsWith("Failed") || msg.startsWith("No") ? "error" : "info");
				return;
			}

			if (sub === "show") {
				if (!sessionExists(session)) {
					ctx.ui.notify("No tmux session for this project.", "info");
					return;
				}
				const windows = getWindows(session);
				const lines = windows.map((w) => `  :${w.index}  ${w.title}${w.active ? "  (active)" : ""}`);
				ctx.ui.notify(`Session ${session} — ${windows.length} window(s)\n${lines.join("\n")}`, "info");
				return;
			}

			if (sub === "cat") {
				await handleCat(ctx, pi, session);
				return;
			}

			if (sub === "clear") {
				handleClear(ctx, session);
				return;
			}

			if (sub === "kill") {
				if (!sessionExists(session)) {
					ctx.ui.notify("No tmux session to kill.", "info");
					return;
				}
				closeAttachedSessions(session);
				exec(`tmux kill-session -t ${session}`);
				ctx.ui.notify(`Killed session ${session}.`, "info");
				return;
			}

			if (sub === "help") {
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
				return;
			}

			ctx.ui.notify(`Unknown: /tmux ${sub}. Try /tmux help`, "warning");
		},
	});
}

async function showSettingsPanel(ctx: ExtensionCommandContext, _pi: ExtensionAPI): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(
			[`auto-attach: ${currentSettings.autoAttach}`, `default-layout: ${currentSettings.defaultLayout}`, `allow-mute: ${currentSettings.allowMute}`, `max-windows: ${currentSettings.maxWindows}`].join(
				"\n",
			),
			"info",
		);
		return;
	}

	const { getSettingsListTheme } = await import("@mariozechner/pi-coding-agent");
	const { Container, SettingsList, Text: TuiText } = await import("@mariozechner/pi-tui");

	let settingsChanged = false;

	await ctx.ui.custom((_tui, theme, _kb, done) => {
		const maxWindowValues = Array.from({ length: 10 }, (_, i) => String((i + 1) * 5));
		const currentMaxStr = String(currentSettings.maxWindows);
		if (!maxWindowValues.includes(currentMaxStr)) {
			maxWindowValues.push(currentMaxStr);
			maxWindowValues.sort((a, b) => Number(a) - Number(b));
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
				currentValue: currentMaxStr,
				values: maxWindowValues,
			},
		];

		const container = new Container();
		container.addChild(new TuiText(theme.fg("accent", theme.bold("tmux settings")), 1, 1));

		const settingsList = new SettingsList(items, 10, getSettingsListTheme(), (id, newValue) => {
			settingsChanged = true;
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
		return {
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				settingsList.handleInput?.(data);
			},
		};
	});

	if (settingsChanged) {
		const shouldReload = await ctx.ui.confirm("Reload Required", "Settings changed. Reload pi to update tool capabilities?");
		if (shouldReload) {
			await ctx.reload();
			return;
		}
		ctx.ui.notify("Settings saved. Use /reload to apply tool changes.", "info");
	}
}

async function handleCat(ctx: ExtensionCommandContext, pi: ExtensionAPI, session: string): Promise<void> {
	if (!sessionExists(session)) {
		ctx.ui.notify("No tmux session for this project.", "error");
		return;
	}
	const windows = getWindows(session);
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
		const idx = typeof choice === "number" ? choice - 1 : options.indexOf(String(choice)) - 1;
		const win = windows[idx];
		if (!win) {
			ctx.ui.notify("Invalid window selection.", "error");
			return;
		}
		target = win.index;
	}
	const output = capturePanes(session, target);

	pi.sendUserMessage(`Here is the tmux output:\n\n\`\`\`\n${output}\n\`\`\``, {
		deliverAs: "followUp",
	});
}

function handleClear(ctx: ExtensionCommandContext, session: string): void {
	if (!sessionExists(session)) {
		ctx.ui.notify("No tmux session for this project.", "error");
		return;
	}

	const shells = new Set(["bash", "zsh", "sh", "fish", "dash"]);
	const raw = execSafe(`tmux list-windows -t ${session} -F "#{window_index}|||#{window_name}|||#{pane_current_command}|||#{pane_pid}"`);
	if (!raw) {
		ctx.ui.notify("No windows in session.", "error");
		return;
	}

	const idle = raw
		.split("\n")
		.map((line) => {
			const [idx, _name, cmd, pid] = line.split("|||");
			return { index: parseInt(idx ?? "0"), cmd: cmd ?? "", pid: pid ?? "" };
		})
		.filter((w) => {
			if (!shells.has(w.cmd)) return false;
			const children = execSafe(`pgrep -P ${w.pid}`);
			return !children;
		});

	if (idle.length === 0) {
		ctx.ui.notify("No idle windows to clear.", "info");
		return;
	}

	for (const w of idle) {
		execSafe(`tmux kill-window -t ${session}:${w.index}`);
	}

	if (!sessionExists(session)) {
		ctx.ui.notify(`Cleared ${idle.length} idle window(s) — session closed.`, "info");
	} else {
		ctx.ui.notify(`Cleared ${idle.length} idle window(s).`, "info");
	}
}
