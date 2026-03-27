import { describe, expect, test } from "bun:test";
import { deriveSessionName, resolveProjectRoot, tmuxEscape } from "../extensions/session.js";

describe("deriveSessionName()", () => {
	test("produces a slug-hash format", () => {
		const name = deriveSessionName("/Users/victor/workspace/my-project");
		expect(name).toMatch(/^[a-z0-9-]+-[a-f0-9]{8}$/);
	});

	test("slug is derived from directory name", () => {
		const name = deriveSessionName("/some/path/cool-project");
		expect(name.startsWith("cool-project-")).toBe(true);
	});

	test("truncates long directory names to 16 chars", () => {
		const name = deriveSessionName("/path/this-is-a-very-long-directory-name");
		const slug = name.split("-").slice(0, -1).join("-");
		expect(slug.length).toBeLessThanOrEqual(16);
	});

	test("deterministic — same input always produces same output", () => {
		const a = deriveSessionName("/foo/bar");
		const b = deriveSessionName("/foo/bar");
		expect(a).toBe(b);
	});

	test("different paths produce different names", () => {
		const a = deriveSessionName("/foo/bar");
		const b = deriveSessionName("/foo/baz");
		expect(a).not.toBe(b);
	});

	test("handles root path with no directory name", () => {
		const name = deriveSessionName("/");
		expect(name).toMatch(/^[a-z0-9-]+-[a-f0-9]{8}$/);
	});
});

describe("tmuxEscape()", () => {
	test("escapes double quotes", () => {
		expect(tmuxEscape('hello "world"')).toBe('hello \\"world\\"');
	});

	test("passes through strings without quotes", () => {
		expect(tmuxEscape("hello world")).toBe("hello world");
	});

	test("handles empty string", () => {
		expect(tmuxEscape("")).toBe("");
	});
});

describe("resolveProjectRoot()", () => {
	test("returns cwd for non-git directories", () => {
		const result = resolveProjectRoot("/tmp");
		expect(result).toBe("/tmp");
	});

	test("returns git root for git directories", () => {
		// This test runs from within the pi-tmux repo
		const result = resolveProjectRoot(process.cwd());
		// Should be the repo root, not cwd if cwd is a subdirectory
		expect(result).toMatch(/pi-tmux$/);
	});
});
