import { describe, expect, test } from "bun:test";
import { deriveSessionName, deriveWindowName, resolveProjectRoot, tmuxEscape } from "../extensions/session.js";

// ---------------------------------------------------------------------------
// deriveSessionName()
// ---------------------------------------------------------------------------

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

	test("strips leading dots from directory names (tmux renames .foo to _foo)", () => {
		const name = deriveSessionName("/Users/victor/.pi");
		expect(name).not.toMatch(/^\./);
		expect(name.startsWith("pi-")).toBe(true);
	});

	test("strips multiple leading dots", () => {
		const name = deriveSessionName("/home/user/..hidden");
		expect(name).not.toMatch(/^\./);
	});

	test("dot-only directory name falls back to 'pi'", () => {
		const name = deriveSessionName("/path/...");
		expect(name.startsWith("pi-")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// deriveWindowName()
// ---------------------------------------------------------------------------

describe("deriveWindowName()", () => {
	test("extracts executable name from simple command", () => {
		expect(deriveWindowName("npm run dev")).toBe("npm");
	});

	test("extracts executable name from full path", () => {
		expect(deriveWindowName("/usr/bin/node server.js")).toBe("node");
	});

	test("handles pipe — takes first segment", () => {
		expect(deriveWindowName("cat file.txt | grep foo")).toBe("cat");
	});

	test("handles semicolons — takes first segment", () => {
		expect(deriveWindowName("cd /tmp; ls -la")).toBe("cd");
	});

	test("handles ampersand sequences — takes first segment", () => {
		expect(deriveWindowName("echo foo && echo bar")).toBe("echo");
	});

	test("truncates long command names to 30 chars", () => {
		const long = "a".repeat(40);
		expect(deriveWindowName(long).length).toBeLessThanOrEqual(30);
	});

	test("falls back to 'shell' for empty command", () => {
		expect(deriveWindowName("")).toBe("shell");
	});

	test("falls back to 'shell' for whitespace-only command", () => {
		expect(deriveWindowName("   ")).toBe("shell");
	});

	test("strips leading whitespace before extracting name", () => {
		expect(deriveWindowName("  bun run test")).toBe("bun");
	});

	test("handles command with no spaces", () => {
		expect(deriveWindowName("htop")).toBe("htop");
	});
});

// ---------------------------------------------------------------------------
// tmuxEscape()
// ---------------------------------------------------------------------------

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

	test("escapes multiple double quotes", () => {
		expect(tmuxEscape('"a" and "b"')).toBe('\\"a\\" and \\"b\\"');
	});

	test("does not escape single quotes", () => {
		expect(tmuxEscape("it's fine")).toBe("it's fine");
	});
});

// ---------------------------------------------------------------------------
// resolveProjectRoot()
// ---------------------------------------------------------------------------

describe("resolveProjectRoot()", () => {
	test("returns cwd for non-git directories", () => {
		const result = resolveProjectRoot("/tmp");
		expect(result).toBe("/tmp");
	});

	test("returns git root for git directories", () => {
		const result = resolveProjectRoot(process.cwd());
		expect(result).toMatch(/pi-tmux$/);
	});
});
