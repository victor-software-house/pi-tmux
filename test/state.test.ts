import { describe, expect, test, mock, beforeEach } from "bun:test";

// Mock execSync before importing state (session.ts uses it)
const execSyncMock = mock((_cmd?: string) => "");
mock.module("node:child_process", () => ({
	execSync: execSyncMock,
}));

import {
	loadPersistedState,
	getOrCreateBinding,
	notifySessionCreated,
	getPersistedSessionName,
	rehydrate,
	clearCache,
	getCachedState,
	type TmuxSessionStateV1,
} from "../extensions/state.js";

// ---------------------------------------------------------------------------
// Helpers — minimal fakes for ExtensionAPI and SessionManager
// ---------------------------------------------------------------------------

function makeEntry(customType: string, data: unknown) {
	return { type: "custom" as const, customType, data, id: "e1", parentId: null, timestamp: "" };
}

function fakeSessionManager(entries: ReturnType<typeof makeEntry>[] = []) {
	return { getEntries: () => entries } as unknown as Parameters<typeof loadPersistedState>[0];
}

function fakeExtensionAPI() {
	const appended: Array<{ customType: string; data: unknown }> = [];
	return {
		appendEntry: (customType: string, data: unknown) => { appended.push({ customType, data }); },
		_appended: appended,
	} as unknown as Parameters<typeof getOrCreateBinding>[0] & { _appended: typeof appended };
}

// ---------------------------------------------------------------------------
// loadPersistedState()
// ---------------------------------------------------------------------------

describe("loadPersistedState()", () => {
	test("returns null when no entries exist", () => {
		const sm = fakeSessionManager([]);
		expect(loadPersistedState(sm)).toBeNull();
	});

	test("returns null when no pi-tmux-state entry exists", () => {
		const sm = fakeSessionManager([makeEntry("other-extension", { foo: 1 })]);
		expect(loadPersistedState(sm)).toBeNull();
	});

	test("returns the latest valid state", () => {
		const old: TmuxSessionStateV1 = { version: 1, tmuxSessionName: "old-abc", hostSessionName: null, createdFromCwd: "/old", updatedAt: 1000 };
		const latest: TmuxSessionStateV1 = { version: 1, tmuxSessionName: "new-def", hostSessionName: null, createdFromCwd: "/new", updatedAt: 2000 };
		const sm = fakeSessionManager([
			makeEntry("pi-tmux-state", old),
			makeEntry("pi-tmux-state", latest),
		]);
		expect(loadPersistedState(sm)).toEqual(latest);
	});

	test("skips malformed entries and returns valid one", () => {
		const valid: TmuxSessionStateV1 = { version: 1, tmuxSessionName: "good-abc", hostSessionName: null, createdFromCwd: "/good", updatedAt: 1000 };
		const sm = fakeSessionManager([
			makeEntry("pi-tmux-state", valid),
			makeEntry("pi-tmux-state", { version: 99, bad: true }),
		]);
		expect(loadPersistedState(sm)).toEqual(valid);
	});

	test("skips entries with empty tmuxSessionName", () => {
		const sm = fakeSessionManager([
			makeEntry("pi-tmux-state", { version: 1, tmuxSessionName: "", hostSessionName: null, createdFromCwd: "/x", updatedAt: 1 }),
		]);
		expect(loadPersistedState(sm)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// getOrCreateBinding()
// ---------------------------------------------------------------------------

describe("getOrCreateBinding()", () => {
	beforeEach(() => {
		clearCache();
		execSyncMock.mockReset();
	});

	test("initializes fresh state when no persisted entry exists", () => {
		// resolveProjectRoot will call git which throws, falling back to cwd
		execSyncMock.mockImplementation((_cmd?: string) => {
			const cmd = _cmd ?? "";
			if (cmd.includes("rev-parse")) throw new Error("not a git repo");
			if (cmd.includes("has-session")) throw new Error("no session");
			return "";
		});

		const pi = fakeExtensionAPI();
		const sm = fakeSessionManager([]);
		const binding = getOrCreateBinding(pi, sm, "/tmp/my-project");

		expect(binding.tmuxSessionName).toMatch(/^my-project-[a-f0-9]{8}$/);
		expect(binding.stagingSessionName).toBe(`${binding.tmuxSessionName}-stg`);
		expect(pi._appended).toHaveLength(1);
		expect(pi._appended[0]?.customType).toBe("pi-tmux-state");
	});

	test("uses persisted state instead of deriving from cwd", () => {
		const persisted: TmuxSessionStateV1 = {
			version: 1,
			tmuxSessionName: "persisted-session-abc12345",
			hostSessionName: null, createdFromCwd: "/original/project",
			updatedAt: 1000,
		};

		execSyncMock.mockImplementation((_cmd?: string) => {
			const cmd = _cmd ?? "";
			if (cmd.includes("has-session")) throw new Error("no session");
			return "";
		});

		const pi = fakeExtensionAPI();
		const sm = fakeSessionManager([makeEntry("pi-tmux-state", persisted)]);
		const binding = getOrCreateBinding(pi, sm, "/completely/different/cwd");

		expect(binding.tmuxSessionName).toBe("persisted-session-abc12345");
		expect(pi._appended).toHaveLength(0);
	});

	test("uses cached state on subsequent calls", () => {
		execSyncMock.mockImplementation((_cmd?: string) => {
			const cmd = _cmd ?? "";
			if (cmd.includes("rev-parse")) throw new Error("not a git repo");
			if (cmd.includes("has-session")) throw new Error("no session");
			return "";
		});

		const pi = fakeExtensionAPI();
		const sm = fakeSessionManager([]);

		const first = getOrCreateBinding(pi, sm, "/tmp/project");
		const second = getOrCreateBinding(pi, sm, "/totally/different/path");

		expect(first.tmuxSessionName).toBe(second.tmuxSessionName);
		expect(pi._appended).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// rehydrate() + clearCache()
// ---------------------------------------------------------------------------

describe("rehydrate()", () => {
	beforeEach(() => clearCache());

	test("populates cache from session entries", () => {
		const state: TmuxSessionStateV1 = { version: 1, tmuxSessionName: "rehydrated-abc", hostSessionName: null, createdFromCwd: "/x", updatedAt: 1 };
		const sm = fakeSessionManager([makeEntry("pi-tmux-state", state)]);

		expect(getCachedState()).toBeNull();
		rehydrate(sm);
		expect(getCachedState()).toEqual(state);
	});

	test("clearCache resets the cache", () => {
		const state: TmuxSessionStateV1 = { version: 1, tmuxSessionName: "abc", hostSessionName: null, createdFromCwd: "/x", updatedAt: 1 };
		const sm = fakeSessionManager([makeEntry("pi-tmux-state", state)]);
		rehydrate(sm);
		expect(getCachedState()).not.toBeNull();
		clearCache();
		expect(getCachedState()).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// notifySessionCreated()
// ---------------------------------------------------------------------------

describe("notifySessionCreated()", () => {
	beforeEach(() => clearCache());

	test("persists state when no prior state exists", () => {
		const pi = fakeExtensionAPI();
		const sm = fakeSessionManager([]);

		notifySessionCreated(pi, sm, "new-session-xyz", "/project");

		expect(pi._appended).toHaveLength(1);
		const data = pi._appended[0]?.data as TmuxSessionStateV1;
		expect(data.tmuxSessionName).toBe("new-session-xyz");
		expect(data.createdFromCwd).toBe("/project");
	});

	test("does not persist when already tracking the same session name", () => {
		const existing: TmuxSessionStateV1 = { version: 1, tmuxSessionName: "same-name", hostSessionName: null, createdFromCwd: "/x", updatedAt: 1 };
		const pi = fakeExtensionAPI();
		const sm = fakeSessionManager([makeEntry("pi-tmux-state", existing)]);

		notifySessionCreated(pi, sm, "same-name", "/different/cwd");

		expect(pi._appended).toHaveLength(0);
	});

	test("persists when session name changed", () => {
		const existing: TmuxSessionStateV1 = { version: 1, tmuxSessionName: "old-name", hostSessionName: null, createdFromCwd: "/x", updatedAt: 1 };
		const pi = fakeExtensionAPI();
		const sm = fakeSessionManager([makeEntry("pi-tmux-state", existing)]);

		notifySessionCreated(pi, sm, "new-name", "/project");

		expect(pi._appended).toHaveLength(1);
		expect((pi._appended[0]?.data as TmuxSessionStateV1).tmuxSessionName).toBe("new-name");
	});
});

// ---------------------------------------------------------------------------
// getPersistedSessionName()
// ---------------------------------------------------------------------------

describe("getPersistedSessionName()", () => {
	beforeEach(() => clearCache());

	test("returns null when no state exists", () => {
		expect(getPersistedSessionName(fakeSessionManager([]))).toBeNull();
	});

	test("returns the persisted session name", () => {
		const state: TmuxSessionStateV1 = { version: 1, tmuxSessionName: "my-session", hostSessionName: null, createdFromCwd: "/x", updatedAt: 1 };
		const sm = fakeSessionManager([makeEntry("pi-tmux-state", state)]);
		expect(getPersistedSessionName(sm)).toBe("my-session");
	});
});
