import { describe, expect, test } from "bun:test";
import { getFlags, when, AUTO_ATTACH_VALUES, LAYOUT_VALUES } from "../extensions/settings.js";

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

describe("getFlags()", () => {
	test("canAttach is false when autoAttach is 'never'", () => {
		const flags = getFlags({ autoAttach: "never", defaultLayout: "split-vertical", allowMute: true, maxWindows: 10, windowReuse: "last" });
		expect(flags.canAttach).toBe(false);
	});

	test("canAttach is true when autoAttach is 'session-create'", () => {
		const flags = getFlags({ autoAttach: "session-create", defaultLayout: "split-vertical", allowMute: true, maxWindows: 10, windowReuse: "last" });
		expect(flags.canAttach).toBe(true);
	});

	test("canAttach is true when autoAttach is 'always'", () => {
		const flags = getFlags({ autoAttach: "always", defaultLayout: "tab", allowMute: false, maxWindows: 5, windowReuse: "last" });
		expect(flags.canAttach).toBe(true);
	});

	test("canMute mirrors allowMute", () => {
		expect(getFlags({ autoAttach: "never", defaultLayout: "split-vertical", allowMute: true, maxWindows: 10, windowReuse: "last" }).canMute).toBe(true);
		expect(getFlags({ autoAttach: "never", defaultLayout: "split-vertical", allowMute: false, maxWindows: 10, windowReuse: "last" }).canMute).toBe(false);
	});
});

describe("AUTO_ATTACH_VALUES and LAYOUT_VALUES", () => {
	test("contain expected values", () => {
		expect(AUTO_ATTACH_VALUES).toContain("never");
		expect(AUTO_ATTACH_VALUES).toContain("session-create");
		expect(AUTO_ATTACH_VALUES).toContain("always");
		expect(LAYOUT_VALUES).toContain("split-vertical");
		expect(LAYOUT_VALUES).toContain("tab");
		expect(LAYOUT_VALUES).toContain("split-horizontal");
	});
});


