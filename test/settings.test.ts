import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getFlags,
	when,
	loadSettings,
	saveSettings,
	parseSettings,
	AUTO_ATTACH_VALUES,
	LAYOUT_VALUES,
	WINDOW_REUSE_VALUES,
	MAX_WINDOWS_RANGE,
} from "../extensions/settings.js";
import type { TmuxSettings } from "../extensions/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string | null = null;

function tempSettingsPath(): string {
	tmpDir = mkdtempSync(join(tmpdir(), "pi-tmux-test-"));
	return join(tmpDir, "settings.json");
}

afterEach(() => {
	if (tmpDir) {
		rmSync(tmpDir, { recursive: true, force: true });
		tmpDir = null;
	}
});

const FULL_SETTINGS: TmuxSettings = {
	autoAttach: "always",
	defaultLayout: "tab",
	allowMute: false,
	maxWindows: 5,
	windowReuse: "named",
	autoFocus: "never", completionDelivery: "followUp", completionTriggerTurn: true,
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("AUTO_ATTACH_VALUES", () => {
	test("contains all three modes", () => {
		expect(AUTO_ATTACH_VALUES).toContain("never");
		expect(AUTO_ATTACH_VALUES).toContain("session-create");
		expect(AUTO_ATTACH_VALUES).toContain("always");
		expect(AUTO_ATTACH_VALUES).toHaveLength(3);
	});
});

describe("LAYOUT_VALUES", () => {
	test("contains all three layouts", () => {
		expect(LAYOUT_VALUES).toContain("split-vertical");
		expect(LAYOUT_VALUES).toContain("tab");
		expect(LAYOUT_VALUES).toContain("split-horizontal");
		expect(LAYOUT_VALUES).toHaveLength(3);
	});
});

describe("WINDOW_REUSE_VALUES", () => {
	test("contains all three modes", () => {
		expect(WINDOW_REUSE_VALUES).toContain("last");
		expect(WINDOW_REUSE_VALUES).toContain("named");
		expect(WINDOW_REUSE_VALUES).toContain("never");
		expect(WINDOW_REUSE_VALUES).toHaveLength(3);
	});
});

describe("MAX_WINDOWS_RANGE", () => {
	test("min is 1, max is 50", () => {
		expect(MAX_WINDOWS_RANGE.min).toBe(1);
		expect(MAX_WINDOWS_RANGE.max).toBe(50);
	});
});

// ---------------------------------------------------------------------------
// parseSettings()
// ---------------------------------------------------------------------------

describe("parseSettings()", () => {
	test("parses a complete valid settings object", () => {
		const result = parseSettings(FULL_SETTINGS);
		expect(result.autoAttach).toBe("always");
		expect(result.defaultLayout).toBe("tab");
		expect(result.allowMute).toBe(false);
		expect(result.maxWindows).toBe(5);
		expect(result.windowReuse).toBe("named");
	});

	test("defaults autoAttach when value is invalid", () => {
		const result = parseSettings({ ...FULL_SETTINGS, autoAttach: "bad-value" });
		expect(result.autoAttach).toBe("session-create");
	});

	test("defaults defaultLayout when value is invalid", () => {
		const result = parseSettings({ ...FULL_SETTINGS, defaultLayout: "full-screen" });
		expect(result.defaultLayout).toBe("split-vertical");
	});

	test("defaults allowMute when value is not boolean", () => {
		const result = parseSettings({ ...FULL_SETTINGS, allowMute: "yes" });
		expect(result.allowMute).toBe(true);
	});

	test("defaults maxWindows when value is out of range (too low)", () => {
		const result = parseSettings({ ...FULL_SETTINGS, maxWindows: 0 });
		expect(result.maxWindows).toBe(10);
	});

	test("defaults maxWindows when value is out of range (too high)", () => {
		const result = parseSettings({ ...FULL_SETTINGS, maxWindows: 999 });
		expect(result.maxWindows).toBe(10);
	});

	test("floors fractional maxWindows", () => {
		const result = parseSettings({ ...FULL_SETTINGS, maxWindows: 7.9 });
		expect(result.maxWindows).toBe(7);
	});

	test("defaults windowReuse when value is invalid", () => {
		const result = parseSettings({ ...FULL_SETTINGS, windowReuse: "always" });
		expect(result.windowReuse).toBe("last");
	});

	test("defaults windowReuse when missing", () => {
		const { windowReuse: _, ...without } = FULL_SETTINGS;
		const result = parseSettings(without);
		expect(result.windowReuse).toBe("last");
	});

	test("accepts 'last' windowReuse", () => {
		const result = parseSettings({ ...FULL_SETTINGS, windowReuse: "last", autoFocus: "always", completionDelivery: "followUp", completionTriggerTurn: true });
		expect(result.windowReuse).toBe("last");
	});

	test("accepts 'named' windowReuse", () => {
		const result = parseSettings({ ...FULL_SETTINGS, windowReuse: "named", autoFocus: "always", completionDelivery: "followUp", completionTriggerTurn: true });
		expect(result.windowReuse).toBe("named");
	});

	test("accepts 'never' windowReuse", () => {
		const result = parseSettings({ ...FULL_SETTINGS, windowReuse: "never", autoFocus: "always", completionDelivery: "followUp", completionTriggerTurn: true });
		expect(result.windowReuse).toBe("never");
	});

	test("returns defaults for null input", () => {
		const result = parseSettings(null);
		expect(result.autoAttach).toBe("session-create");
		expect(result.windowReuse).toBe("last");
		expect(result.maxWindows).toBe(10);
	});

	test("returns defaults for empty object", () => {
		const result = parseSettings({});
		expect(result.autoAttach).toBe("session-create");
		expect(result.defaultLayout).toBe("split-vertical");
		expect(result.allowMute).toBe(true);
		expect(result.maxWindows).toBe(10);
		expect(result.windowReuse).toBe("last");
	});
});

// ---------------------------------------------------------------------------
// loadSettings() + saveSettings() round-trip
// ---------------------------------------------------------------------------

describe("loadSettings()", () => {
	test("returns defaults when file does not exist", () => {
		const path = join(tmpdir(), "nonexistent-pi-tmux.json");
		const settings = loadSettings(path);
		expect(settings.autoAttach).toBe("session-create");
		expect(settings.defaultLayout).toBe("split-vertical");
		expect(settings.allowMute).toBe(true);
		expect(settings.maxWindows).toBe(10);
		expect(settings.windowReuse).toBe("last");
	});

	test("round-trips all fields including windowReuse", () => {
		const path = tempSettingsPath();
		saveSettings(FULL_SETTINGS, path);
		const loaded = loadSettings(path);
		expect(loaded.autoAttach).toBe(FULL_SETTINGS.autoAttach);
		expect(loaded.defaultLayout).toBe(FULL_SETTINGS.defaultLayout);
		expect(loaded.allowMute).toBe(FULL_SETTINGS.allowMute);
		expect(loaded.maxWindows).toBe(FULL_SETTINGS.maxWindows);
		expect(loaded.windowReuse).toBe(FULL_SETTINGS.windowReuse);
	});

	test("falls back to default windowReuse when saved value is invalid", () => {
		const path = tempSettingsPath();
		saveSettings(FULL_SETTINGS, path);
		// Corrupt just the windowReuse field
		const raw = JSON.parse(require("node:fs").readFileSync(path, "utf-8"));
		raw.windowReuse = "bogus";
		require("node:fs").writeFileSync(path, JSON.stringify(raw));
		const loaded = loadSettings(path);
		expect(loaded.windowReuse).toBe("last");
	});

	test("round-trips windowReuse: never", () => {
		const path = tempSettingsPath();
		saveSettings({ ...FULL_SETTINGS, windowReuse: "never", autoFocus: "always", completionDelivery: "followUp", completionTriggerTurn: true }, path);
		expect(loadSettings(path).windowReuse).toBe("never");
	});

	test("round-trips windowReuse: last", () => {
		const path = tempSettingsPath();
		saveSettings({ ...FULL_SETTINGS, windowReuse: "last", autoFocus: "always", completionDelivery: "followUp", completionTriggerTurn: true }, path);
		expect(loadSettings(path).windowReuse).toBe("last");
	});

	test("file exists after saveSettings", () => {
		const path = tempSettingsPath();
		expect(existsSync(path)).toBe(false);
		saveSettings(FULL_SETTINGS, path);
		expect(existsSync(path)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// getFlags()
// ---------------------------------------------------------------------------

describe("getFlags()", () => {
	test("canAttach is false when autoAttach is 'never'", () => {
		const flags = getFlags({ autoAttach: "never", defaultLayout: "split-vertical", allowMute: true, maxWindows: 10, windowReuse: "last", autoFocus: "always", completionDelivery: "followUp", completionTriggerTurn: true });
		expect(flags.canAttach).toBe(false);
		expect(flags.autoAttach).toBe("never");
	});

	test("canAttach is true when autoAttach is 'session-create'", () => {
		const flags = getFlags({ autoAttach: "session-create", defaultLayout: "split-vertical", allowMute: true, maxWindows: 10, windowReuse: "last", autoFocus: "always", completionDelivery: "followUp", completionTriggerTurn: true });
		expect(flags.canAttach).toBe(true);
		expect(flags.autoAttach).toBe("session-create");
	});

	test("canAttach is true when autoAttach is 'always'", () => {
		const flags = getFlags({ autoAttach: "always", defaultLayout: "tab", allowMute: false, maxWindows: 5, windowReuse: "last", autoFocus: "always", completionDelivery: "followUp", completionTriggerTurn: true });
		expect(flags.canAttach).toBe(true);
		expect(flags.autoAttach).toBe("always");
	});

	test("canMute mirrors allowMute", () => {
		expect(getFlags({ autoAttach: "never", defaultLayout: "split-vertical", allowMute: true, maxWindows: 10, windowReuse: "last", autoFocus: "always", completionDelivery: "followUp", completionTriggerTurn: true }).canMute).toBe(true);
		expect(getFlags({ autoAttach: "never", defaultLayout: "split-vertical", allowMute: false, maxWindows: 10, windowReuse: "last", autoFocus: "always", completionDelivery: "followUp", completionTriggerTurn: true }).canMute).toBe(false);
	});

	test("windowReuse passes through to flags", () => {
		expect(getFlags({ autoAttach: "never", defaultLayout: "split-vertical", allowMute: true, maxWindows: 10, windowReuse: "named", autoFocus: "always", completionDelivery: "followUp", completionTriggerTurn: true }).windowReuse).toBe("named");
		expect(getFlags({ autoAttach: "never", defaultLayout: "split-vertical", allowMute: true, maxWindows: 10, windowReuse: "never", autoFocus: "always", completionDelivery: "followUp", completionTriggerTurn: true }).windowReuse).toBe("never");
	});
});

// ---------------------------------------------------------------------------
// when()
// ---------------------------------------------------------------------------

describe("when() helper", () => {
	test("returns items when condition is true", () => {
		expect(when(true, "a", "b")).toEqual(["a", "b"]);
	});

	test("returns empty array when condition is false", () => {
		expect(when(false, "a", "b")).toEqual([]);
	});

	test("works with spread in array composition", () => {
		const result = ["always", ...when(true, "conditional"), "also-always"];
		expect(result).toEqual(["always", "conditional", "also-always"]);
	});

	test("spread of false condition adds nothing", () => {
		const result = ["always", ...when(false, "hidden"), "also-always"];
		expect(result).toEqual(["always", "also-always"]);
	});
});
