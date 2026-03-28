import { describe, expect, test } from "bun:test";
import { buildActions, buildDescription, buildPromptSnippet, buildPromptGuidelines, buildParams } from "../extensions/tool-builder.js";
import type { FeatureFlags } from "../extensions/types.js";

const ALL_ENABLED: FeatureFlags = { canAttach: true, canMute: true, autoAttach: "session-create", windowReuse: "last" };
const ATTACH_ONLY: FeatureFlags = { canAttach: true, canMute: false, autoAttach: "session-create", windowReuse: "last" };
const MUTE_ONLY: FeatureFlags = { canAttach: false, canMute: true, autoAttach: "never", windowReuse: "last" };
const ALL_DISABLED: FeatureFlags = { canAttach: false, canMute: false, autoAttach: "never", windowReuse: "last" };
const AUTO_ALWAYS: FeatureFlags = { canAttach: true, canMute: false, autoAttach: "always", windowReuse: "last" };
const REUSE_NEVER: FeatureFlags = { canAttach: false, canMute: false, autoAttach: "never", windowReuse: "never" };
const REUSE_NAMED: FeatureFlags = { canAttach: false, canMute: false, autoAttach: "never", windowReuse: "named" };

// ---------------------------------------------------------------------------
// buildActions()
// ---------------------------------------------------------------------------

describe("buildActions()", () => {
	test("includes attach and mute when both enabled", () => {
		const actions = buildActions(ALL_ENABLED);
		expect(actions).toContain("run");
		expect(actions).toContain("attach");
		expect(actions).toContain("peek");
		expect(actions).toContain("list");
		expect(actions).toContain("kill");
		expect(actions).toContain("mute");
	});

	test("excludes attach when canAttach is false", () => {
		const actions = buildActions(MUTE_ONLY);
		expect(actions).not.toContain("attach");
		expect(actions).toContain("mute");
	});

	test("excludes mute when canMute is false", () => {
		const actions = buildActions(ATTACH_ONLY);
		expect(actions).toContain("attach");
		expect(actions).not.toContain("mute");
	});

	test("minimal set when all disabled", () => {
		const actions = buildActions(ALL_DISABLED);
		expect(actions).toEqual(["run", "focus", "close", "peek", "list", "kill"]);
	});

	test("always includes run, peek, list, kill", () => {
		for (const flags of [ALL_ENABLED, ALL_DISABLED, ATTACH_ONLY, MUTE_ONLY]) {
			const actions = buildActions(flags);
			expect(actions).toContain("run");
			expect(actions).toContain("peek");
			expect(actions).toContain("list");
			expect(actions).toContain("kill");
		}
	});
});

// ---------------------------------------------------------------------------
// buildParams()
// ---------------------------------------------------------------------------

describe("buildParams()", () => {
	test("command param is always present", () => {
		for (const flags of [ALL_ENABLED, ALL_DISABLED, AUTO_ALWAYS]) {
			expect(buildParams(flags).properties.command).toBeDefined();
		}
	});

	test("no attach boolean param in schema (auto-attach is setting-driven)", () => {
		for (const flags of [ALL_ENABLED, ALL_DISABLED, AUTO_ALWAYS]) {
			const props = buildParams(flags).properties as Record<string, unknown>;
			expect(props.attach).toBeUndefined();
		}
	});

	test("mode param always present for attach action", () => {
		const schema = buildParams(ALL_ENABLED);
		const props = schema.properties as Record<string, { description?: string }>;
		expect(props.mode).toBeDefined();
		expect(props.mode?.description?.toLowerCase()).toContain("attach");
	});

	test("name param describes windowReuse: last semantics", () => {
		const schema = buildParams(ALL_ENABLED); // windowReuse: last
		const nameDesc = (schema.properties.name as { description?: string }).description ?? "";
		expect(nameDesc.toLowerCase()).toContain("reuse the last idle window");
	});

	test("name param describes windowReuse: named semantics", () => {
		const schema = buildParams(REUSE_NAMED);
		const nameDesc = (schema.properties.name as { description?: string }).description ?? "";
		expect(nameDesc.toLowerCase()).toContain("reuse");
		expect(nameDesc.toLowerCase()).toContain("named");
	});

	test("name param describes windowReuse: never semantics", () => {
		const schema = buildParams(REUSE_NEVER);
		const nameDesc = (schema.properties.name as { description?: string }).description ?? "";
		expect(nameDesc.toLowerCase()).toContain("new window");
	});
});

// ---------------------------------------------------------------------------
// buildDescription()
// ---------------------------------------------------------------------------

describe("buildDescription()", () => {
	test("includes attach action when canAttach", () => {
		const desc = buildDescription(ALL_ENABLED);
		expect(desc).toContain("- attach:");
	});

	test("omits attach action when canAttach is false", () => {
		const desc = buildDescription(ALL_DISABLED);
		expect(desc).not.toContain("- attach:");
	});

	test("mentions auto-attach behaviour for session-create", () => {
		const desc = buildDescription(ALL_ENABLED); // session-create
		expect(desc.toLowerCase()).toContain("new session");
	});

	test("mentions auto-attach behaviour for always", () => {
		const desc = buildDescription(AUTO_ALWAYS);
		expect(desc.toLowerCase()).toContain("every run");
	});

	test("does not mention attach: true when autoAttach is always", () => {
		const desc = buildDescription(AUTO_ALWAYS);
		expect(desc).not.toContain("attach: true");
	});

	test("does not mention attach: true (auto-attach is setting-driven)", () => {
		const desc = buildDescription(ALL_ENABLED);
		expect(desc).not.toContain("attach: true");
	});

	test("includes mute when canMute", () => {
		const desc = buildDescription(ALL_ENABLED);
		expect(desc).toContain("- mute:");
	});

	test("omits mute when canMute is false", () => {
		const desc = buildDescription(ALL_DISABLED);
		expect(desc).not.toContain("- mute:");
	});
});

// ---------------------------------------------------------------------------
// buildPromptSnippet()
// ---------------------------------------------------------------------------

describe("buildPromptSnippet()", () => {
	test("always mentions tmux and long-running", () => {
		for (const flags of [ALL_ENABLED, ALL_DISABLED, AUTO_ALWAYS]) {
			const snippet = buildPromptSnippet(flags);
			expect(snippet).toContain("tmux");
			expect(snippet).toContain("long-running");
		}
	});

	test("mentions auto-attach for session-create", () => {
		const snippet = buildPromptSnippet(ALL_ENABLED);
		expect(snippet.toLowerCase()).toContain("new session");
	});

	test("mentions auto-attach for always", () => {
		const snippet = buildPromptSnippet(AUTO_ALWAYS);
		expect(snippet.toLowerCase()).toContain("every run");
	});

	test("no attach mention when canAttach is false", () => {
		const snippet = buildPromptSnippet(ALL_DISABLED);
		expect(snippet.toLowerCase()).not.toContain("attach");
	});
});

// ---------------------------------------------------------------------------
// buildPromptGuidelines()
// ---------------------------------------------------------------------------

describe("buildPromptGuidelines()", () => {
	test("always includes bash comparison", () => {
		for (const flags of [ALL_ENABLED, ALL_DISABLED, AUTO_ALWAYS]) {
			expect(buildPromptGuidelines(flags).some((g) => g.includes("Use bash for quick"))).toBe(true);
		}
	});

	test("always includes silenceTimeout", () => {
		for (const flags of [ALL_ENABLED, ALL_DISABLED, AUTO_ALWAYS]) {
			expect(buildPromptGuidelines(flags).some((g) => g.includes("silenceTimeout"))).toBe(true);
		}
	});

	test("always includes no-kill", () => {
		for (const flags of [ALL_ENABLED, ALL_DISABLED, AUTO_ALWAYS]) {
			expect(buildPromptGuidelines(flags).some((g) => g.includes("Do not kill sessions"))).toBe(true);
		}
	});

	test("attach guideline for session-create describes auto behavior", () => {
		const guidelines = buildPromptGuidelines(ALL_ENABLED);
		expect(guidelines.some((g) => g.toLowerCase().includes("new session"))).toBe(true);
		// No attach: true — auto-attach is setting-driven
		expect(guidelines.some((g) => g.includes("attach: true"))).toBe(false);
	});

	test("attach guideline for always describes auto behavior", () => {
		const guidelines = buildPromptGuidelines(AUTO_ALWAYS);
		expect(guidelines.some((g) => g.toLowerCase().includes("every run"))).toBe(true);
		expect(guidelines.some((g) => g.includes("attach: true"))).toBe(false);
	});

	test("no attach guideline when canAttach is false", () => {
		const guidelines = buildPromptGuidelines(ALL_DISABLED);
		expect(guidelines.some((g) => g.includes("attach: true"))).toBe(false);
		expect(guidelines.some((g) => g.toLowerCase().includes("terminal opens"))).toBe(false);
	});

	test("windowReuse: last guideline mentions last idle window", () => {
		const guidelines = buildPromptGuidelines(ALL_ENABLED); // windowReuse: last
		expect(guidelines.some((g) => g.toLowerCase().includes("last idle"))).toBe(true);
	});

	test("windowReuse: named guideline mentions named window", () => {
		const guidelines = buildPromptGuidelines(REUSE_NAMED);
		expect(guidelines.some((g) => g.toLowerCase().includes("named"))).toBe(true);
	});

	test("windowReuse: never guideline mentions new window", () => {
		const guidelines = buildPromptGuidelines(REUSE_NEVER);
		expect(guidelines.some((g) => g.toLowerCase().includes("new window"))).toBe(true);
	});

	test("mute guideline present when canMute", () => {
		expect(buildPromptGuidelines(ALL_ENABLED).some((g) => g.toLowerCase().includes("mute"))).toBe(true);
	});

	test("no mute guideline when canMute is false", () => {
		expect(buildPromptGuidelines(ALL_DISABLED).some((g) => g.toLowerCase().includes("mute"))).toBe(false);
	});
});
