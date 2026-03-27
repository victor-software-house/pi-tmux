import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AutoAttachMode, AttachLayout, FeatureFlags, TmuxSettings, WindowReuse } from "./types.js";

export const AUTO_ATTACH_VALUES: readonly AutoAttachMode[] = ["never", "session-create", "always"];
export const LAYOUT_VALUES: readonly AttachLayout[] = ["split-vertical", "tab", "split-horizontal"];
export const WINDOW_REUSE_VALUES: readonly WindowReuse[] = ["last", "named", "never"];
export const MAX_WINDOWS_RANGE = { min: 1, max: 50 } as const;

const DEFAULT_SETTINGS: TmuxSettings = {
	autoAttach: "session-create",
	defaultLayout: "split-vertical",
	allowMute: true,
	maxWindows: 10,
	windowReuse: "last",
};

const SETTINGS_PATH = join(homedir(), ".pi", "agent", ".pi-tmux.json");

export function getConfigPath(): string {
	return SETTINGS_PATH;
}

export function loadSettings(): TmuxSettings {
	try {
		if (!existsSync(SETTINGS_PATH)) return { ...DEFAULT_SETTINGS };
		const raw = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
		return {
			autoAttach: AUTO_ATTACH_VALUES.includes(raw?.autoAttach) ? raw.autoAttach : DEFAULT_SETTINGS.autoAttach,
			defaultLayout: LAYOUT_VALUES.includes(raw?.defaultLayout) ? raw.defaultLayout : DEFAULT_SETTINGS.defaultLayout,
			allowMute: typeof raw?.allowMute === "boolean" ? raw.allowMute : DEFAULT_SETTINGS.allowMute,
			maxWindows:
				typeof raw?.maxWindows === "number" && raw.maxWindows >= MAX_WINDOWS_RANGE.min && raw.maxWindows <= MAX_WINDOWS_RANGE.max
					? Math.floor(raw.maxWindows)
					: DEFAULT_SETTINGS.maxWindows,
			windowReuse: WINDOW_REUSE_VALUES.includes(raw?.windowReuse) ? raw.windowReuse : DEFAULT_SETTINGS.windowReuse,
		};
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

export function saveSettings(settings: TmuxSettings): void {
	const dir = join(homedir(), ".pi", "agent");
	mkdirSync(dir, { recursive: true });
	writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
}

export function getFlags(settings: TmuxSettings): FeatureFlags {
	return {
		canAttach: settings.autoAttach !== "never",
		canMute: settings.allowMute,
	};
}

/** Conditional include helper for composing arrays and prompt sections. */
export function when<T>(condition: boolean, ...items: T[]): T[] {
	return condition ? items : [];
}
