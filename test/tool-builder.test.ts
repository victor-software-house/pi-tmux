import { describe, expect, test } from "bun:test";
import { buildActions, buildDescription, buildPromptSnippet, buildPromptGuidelines } from "../extensions/tool-builder.js";
import type { FeatureFlags } from "../extensions/types.js";

const ALL_ENABLED: FeatureFlags = { canAttach: true, canMute: true };
const ATTACH_ONLY: FeatureFlags = { canAttach: true, canMute: false };
const MUTE_ONLY: FeatureFlags = { canAttach: false, canMute: true };
const ALL_DISABLED: FeatureFlags = { canAttach: false, canMute: false };

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
		expect(actions).toEqual(["run", "peek", "list", "kill"]);
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

describe("buildDescription()", () => {
	test("mentions attach action when canAttach is true", () => {
		const desc = buildDescription(ALL_ENABLED);
		expect(desc).toContain("attach");
		expect(desc).toContain("attach: true");
	});

	test("omits attach references when canAttach is false", () => {
		const desc = buildDescription(ALL_DISABLED);
		expect(desc).not.toContain("attach: true");
		expect(desc).not.toContain("- attach:");
	});

	test("mentions mute when canMute is true", () => {
		const desc = buildDescription(ALL_ENABLED);
		expect(desc).toContain("mute");
	});

	test("omits mute when canMute is false", () => {
		const desc = buildDescription(ALL_DISABLED);
		expect(desc).not.toContain("- mute:");
	});

	test("mentions disabled attachment when canAttach is false", () => {
		const desc = buildDescription(ALL_DISABLED);
		expect(desc).toContain("disabled in user settings");
	});
});

describe("buildPromptSnippet()", () => {
	test("includes attach guidance when enabled", () => {
		const snippet = buildPromptSnippet(ALL_ENABLED);
		expect(snippet).toContain("attach");
	});

	test("excludes attach guidance when disabled", () => {
		const snippet = buildPromptSnippet(ALL_DISABLED);
		expect(snippet).not.toContain("attach");
	});

	test("always mentions tmux and long-running commands", () => {
		for (const flags of [ALL_ENABLED, ALL_DISABLED]) {
			const snippet = buildPromptSnippet(flags);
			expect(snippet).toContain("tmux");
			expect(snippet).toContain("long-running");
		}
	});
});

describe("buildPromptGuidelines()", () => {
	test("includes attach guideline when canAttach is true", () => {
		const guidelines = buildPromptGuidelines(ALL_ENABLED);
		const hasAttachGuideline = guidelines.some((g) => g.includes("attach: true"));
		expect(hasAttachGuideline).toBe(true);
	});

	test("excludes attach guideline when canAttach is false", () => {
		const guidelines = buildPromptGuidelines(ALL_DISABLED);
		const hasAttachGuideline = guidelines.some((g) => g.includes("attach: true"));
		expect(hasAttachGuideline).toBe(false);
	});

	test("includes mute guideline when canMute is true", () => {
		const guidelines = buildPromptGuidelines(ALL_ENABLED);
		const hasMuteGuideline = guidelines.some((g) => g.toLowerCase().includes("mute"));
		expect(hasMuteGuideline).toBe(true);
	});

	test("excludes mute guideline when canMute is false", () => {
		const guidelines = buildPromptGuidelines(ALL_DISABLED);
		const hasMuteGuideline = guidelines.some((g) => g.toLowerCase().includes("mute"));
		expect(hasMuteGuideline).toBe(false);
	});

	test("always includes core guidelines", () => {
		for (const flags of [ALL_ENABLED, ALL_DISABLED]) {
			const guidelines = buildPromptGuidelines(flags);
			const hasBashComparison = guidelines.some((g) => g.includes("Use bash for quick"));
			const hasSilenceTimeout = guidelines.some((g) => g.includes("silenceTimeout"));
			const hasNoKill = guidelines.some((g) => g.includes("Do not kill sessions"));
			expect(hasBashComparison).toBe(true);
			expect(hasSilenceTimeout).toBe(true);
			expect(hasNoKill).toBe(true);
		}
	});
});
