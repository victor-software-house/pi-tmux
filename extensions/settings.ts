import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AutoAttachMode, AttachLayout, AutoFocus, CompletionDelivery, FeatureFlags, TmuxSettings, WindowReuse } from "./types.js";

export const AUTO_ATTACH_VALUES: readonly AutoAttachMode[] = ["never", "session-create", "always"];
export const LAYOUT_VALUES: readonly AttachLayout[] = ["split-vertical", "tab", "split-horizontal"];
export const WINDOW_REUSE_VALUES: readonly WindowReuse[] = ["last", "named", "never"];
export const AUTO_FOCUS_VALUES: readonly AutoFocus[] = ["always", "never"];
export const COMPLETION_DELIVERY_VALUES: readonly CompletionDelivery[] = ["steer", "followUp", "nextTurn"];
export const MAX_WINDOWS_RANGE = { min: 1, max: 50 } as const;

const DEFAULT_SETTINGS: TmuxSettings = {
	autoAttach: "session-create",
	defaultLayout: "split-vertical",
	allowMute: true,
	maxWindows: 10,
	windowReuse: "last",
	autoFocus: "always",
	completionDelivery: "followUp",
};

const SETTINGS_PATH = join(homedir(), ".pi", "agent", ".pi-tmux.json");

export function getConfigPath(): string {
	return SETTINGS_PATH;
}

export function parseSettings(raw: unknown): TmuxSettings {
	const r = raw as Record<string, unknown>;
	return {
		autoAttach: AUTO_ATTACH_VALUES.includes(r?.autoAttach as AutoAttachMode) ? (r.autoAttach as AutoAttachMode) : DEFAULT_SETTINGS.autoAttach,
		defaultLayout: LAYOUT_VALUES.includes(r?.defaultLayout as AttachLayout) ? (r.defaultLayout as AttachLayout) : DEFAULT_SETTINGS.defaultLayout,
		allowMute: typeof r?.allowMute === "boolean" ? r.allowMute : DEFAULT_SETTINGS.allowMute,
		maxWindows:
			typeof r?.maxWindows === "number" && r.maxWindows >= MAX_WINDOWS_RANGE.min && r.maxWindows <= MAX_WINDOWS_RANGE.max
				? Math.floor(r.maxWindows)
				: DEFAULT_SETTINGS.maxWindows,
		windowReuse: WINDOW_REUSE_VALUES.includes(r?.windowReuse as WindowReuse) ? (r.windowReuse as WindowReuse) : DEFAULT_SETTINGS.windowReuse,
		autoFocus: AUTO_FOCUS_VALUES.includes(r?.autoFocus as AutoFocus) ? (r.autoFocus as AutoFocus) : DEFAULT_SETTINGS.autoFocus,
		completionDelivery: COMPLETION_DELIVERY_VALUES.includes(r?.completionDelivery as CompletionDelivery) ? (r.completionDelivery as CompletionDelivery) : DEFAULT_SETTINGS.completionDelivery,
	};
}

export function loadSettings(filePath = SETTINGS_PATH): TmuxSettings {
	try {
		if (!existsSync(filePath)) return { ...DEFAULT_SETTINGS };
		const raw = JSON.parse(readFileSync(filePath, "utf-8"));
		return parseSettings(raw);
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

export function saveSettings(settings: TmuxSettings, filePath = SETTINGS_PATH): void {
	const dir = join(homedir(), ".pi", "agent");
	mkdirSync(dir, { recursive: true });
	writeFileSync(filePath, JSON.stringify(settings, null, 2) + "\n");
}

export function getFlags(settings: TmuxSettings): FeatureFlags {
	return {
		canAttach: settings.autoAttach !== "never",
		canMute: settings.allowMute,
		autoAttach: settings.autoAttach,
		windowReuse: settings.windowReuse,
	};
}

/** Conditional include helper for composing arrays and prompt sections. */
export function when<T>(condition: boolean, ...items: T[]): T[] {
	return condition ? items : [];
}
