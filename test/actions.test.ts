import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import type { HostTarget } from "../extensions/actions.js";

// All tests run in tmux mode — actions.ts no longer supports non-tmux
process.env.TMUX = "cc";

// Mock execSync before importing actions
// biome-ignore: test mock needs flexible signature
const execSyncMock = mock((_cmd?: string) => "");
mock.module("node:child_process", () => ({
	execSync: execSyncMock,
}));

// Mock terminal-tmux module
mock.module("../extensions/terminal-tmux.js", () => ({
	openTerminal: mock(() => "Opened split."),
	closeAttachedSessions: mock(() => {}),
	hasAttachedPane: mock(() => false),
}));

import {
	actionRun,
	actionAttach,
	actionFocus,
	actionClose,
	actionPeek,
	actionList,
	actionKill,
	actionClear,
	actionMute,
} from "../extensions/actions.js";
import { hasAttachedPane } from "../extensions/terminal-tmux.js";

const defaultHost: HostTarget = { session: "5", windowIndex: 0 };

// Helper: configure execSync responses by command pattern
function mockCommands(responses: Record<string, string>): void {
	execSyncMock.mockImplementation((_cmd?: string) => {
		const cmd = _cmd ?? "";
		for (const [pattern, response] of Object.entries(responses)) {
			if (cmd.includes(pattern)) return response;
		}
		throw new Error(`Unmocked command: ${cmd}`);
	});
}

function mockDeadSession(): void {
	execSyncMock.mockImplementation(() => {
		throw new Error("no session");
	});
}

/**
 * Standard inventory: 3 staging panes, one visible (build at staging:1).
 *
 * View pane (%42) has @pi_name=build → visible.
 * Staging:0 has %51 (@pi_name=logs, running node).
 * Staging:1 has %99 (no @pi_name — orphaned shell from swap, idle).
 * Staging:2 has %77 (@pi_name=ci, idle bash).
 */
function mockTmuxInventory(): void {
	execSyncMock.mockImplementation((_cmd?: string) => {
		const cmd = _cmd ?? "";
		if (cmd.includes("has-session -t =test-abc-stg")) return "ok\n";
		// View pane detection
		if (cmd.includes("list-panes -t =5:0 -F \"#{pane_index} #{pane_id}\"")) return "0 %1\n1 %42\n";
		if (cmd.includes("list-panes -t =5:0 -F \"#{pane_index}\t#{pane_id}\t#{pane_current_command}\t#{pane_pid}\"")) return "0\t%1\tzsh\t1001\n1\t%42\tzsh\t4242\n";
		// @pi_name on view pane
		if (cmd.includes("display -p -t %42 \"#{@pi_name}\"")) return "build\n";
		// Staging panes with @pi_name column
		if (cmd.includes("list-panes -s -t =test-abc-stg -F \"#{window_index}\t#{pane_id}\t#{pane_current_command}\t#{pane_pid}\t#{@pi_name}\"")) {
			return "0\t%51\tnode\t5151\tlogs\n1\t%99\tzsh\t9999\t\n2\t%77\tbash\t7777\tci\n";
		}
		// Child process checks
		if (cmd.includes("pgrep -P 4242")) throw new Error("no children");
		if (cmd.includes("pgrep -P 5151")) return "5152\n";
		if (cmd.includes("pgrep -P 7777")) throw new Error("no children");
		// send-keys, capture, swap, kill
		if (cmd.includes("send-keys -t %42")) return "\n";
		if (cmd.includes("capture-pane -t %42")) return "visible build output\n";
		if (cmd.includes("capture-pane -t %51")) return "captured logs\n";
		if (cmd.includes("capture-pane -t %77")) return "captured ci\n";
		if (cmd.includes("capture-pane")) return "(empty)\n";
		if (cmd.includes("swap-pane -d -s =5:0.1 -t %51")) return "\n";
		if (cmd.includes("swap-pane -d -s =5:0.1 -t %77")) return "\n";
		if (cmd.includes("set-option -p")) return "\n";
		if (cmd.includes("kill-pane -t =5:0.1")) return "\n";
		if (cmd.includes("kill-pane -t %51")) return "\n";
		if (cmd.includes("kill-pane -t %77")) return "\n";
		if (cmd.includes("kill-session -t =test-abc-stg")) return "\n";
		return "\n";
	});
}

/**
 * Staging with an idle pane: 2 staging windows, view has pane from staging:1.
 * Staging:0 has %50 (@pi_name=dev, idle zsh) — reusable.
 * Staging:1 has %99 (no @pi_name — orphan, idle).
 * View %42 has @pi_name=build.
 */
function mockStagingWithIdlePane(): void {
	execSyncMock.mockImplementation((_cmd?: string) => {
		const cmd = _cmd ?? "";
		if (cmd.includes("has-session -t =test-abc-stg")) return "ok\n";
		if (cmd.includes("list-panes -t =5:0 -F \"#{pane_index} #{pane_id}\"")) return "0 %1\n1 %42\n";
		if (cmd.includes("list-panes -t =5:0 -F \"#{pane_index}\t#{pane_id}\t#{pane_current_command}\t#{pane_pid}\"")) return "0\t%1\tzsh\t1001\n1\t%42\tzsh\t4242\n";
		if (cmd.includes("display -p -t %42 \"#{@pi_name}\"")) return "build\n";
		if (cmd.includes("list-panes -s -t =test-abc-stg -F \"#{window_index}\t#{pane_id}\t#{pane_current_command}\t#{pane_pid}\t#{@pi_name}\"")) {
			return "0\t%50\tzsh\t5050\tdev\n1\t%99\tzsh\t9999\t\n";
		}
		if (cmd.includes("pgrep -P 4242")) throw new Error("no children");
		if (cmd.includes("pgrep -P 5050")) throw new Error("no children");
		if (cmd.includes("pgrep -P 9999")) throw new Error("no children");
		if (cmd.includes("respawn-pane")) return "\n";
		if (cmd.includes("rename-window")) return "\n";
		if (cmd.includes("display -p -t test-abc-stg:0.0 \"#{pane_id}\"")) return "%50\n";
		if (cmd.includes("display -p -t =test-abc-stg:0.0 \"#{pane_id}\"")) return "%50\n";
		if (cmd.includes("display -p -t %50 \"#{pane_current_command}\t#{cursor_x}\t#{cursor_y}\"")) return "zsh\t5\t2\n";
		if (cmd.includes("capture-pane -t %50 -p -S -5")) return "$ \n";
		if (cmd.includes("send-keys -t %50")) return "\n";
		if (cmd.includes("set-option -p")) return "\n";
		if (cmd.includes("swap-pane")) return "\n";
		return "\n";
	});
}

/**
 * Staging with one running pane: only 1 staging window, not idle.
 * Forces new window creation.
 */
function mockNewStagingWindow(): void {
	execSyncMock.mockImplementation((_cmd?: string) => {
		const cmd = _cmd ?? "";
		if (cmd.includes("has-session -t =test-abc-stg")) return "ok\n";
		if (cmd.includes("list-panes -t =5:0 -F \"#{pane_index} #{pane_id}\"")) return "0 %1\n1 %42\n";
		if (cmd.includes("list-panes -t =5:0 -F \"#{pane_index}\t#{pane_id}\t#{pane_current_command}\t#{pane_pid}\"")) return "0\t%1\tzsh\t1001\n1\t%42\tnode\t4242\n";
		if (cmd.includes("display -p -t %42 \"#{@pi_name}\"")) return "dev\n";
		if (cmd.includes("list-panes -s -t =test-abc-stg -F \"#{window_index}\t#{pane_id}\t#{pane_current_command}\t#{pane_pid}\t#{@pi_name}\"")) {
			return "0\t%50\tnode\t5050\tserver\n";
		}
		if (cmd.includes("pgrep -P 4242")) return "4243\n";
		if (cmd.includes("pgrep -P 5050")) return "5051\n"; // running, not idle
		if (cmd.includes("new-window -d -t =test-abc-stg")) return "\n";
		if (cmd.includes("rename-window")) return "\n";
		if (cmd.includes("display -p -t test-abc-stg:1.0 \"#{pane_id}\"")) return "%60\n";
		if (cmd.includes("display -p -t =test-abc-stg:1.0 \"#{pane_id}\"")) return "%60\n";
		// Wait for quiescence
		if (cmd.includes("display -p -t %60 \"#{pane_current_command}\t#{cursor_x}\t#{cursor_y}\"")) return "zsh\t5\t2\n";
		if (cmd.includes("capture-pane -t %60 -p -S -5")) return "$ \n";
		if (cmd.includes("send-keys -t %60")) return "\n";
		if (cmd.includes("set-option -p")) return "\n";
		if (cmd.includes("swap-pane")) return "\n";
		// list-windows for finding the next index
		if (cmd.includes("list-windows -t =test-abc-stg")) return "0\tdev\n";
		return "\n";
	});
}

describe("actionRun()", () => {
	beforeEach(() => execSyncMock.mockReset());

	test("respawns idle staging window with windowReuse: last", async () => {
		mockStagingWithIdlePane();

		const result = await actionRun("test-abc", {
			command: "npm test",
			cwd: "/tmp/project",
			windowReuse: "last",
			maxWindows: 10,
			autoFocus: "never",
			defaultLayout: "split-vertical",
			shellMode: "fresh",
			host: defaultHost,
		});

		expect(result.ok).toBe(true);
		expect(result.message).toContain("Respawned pane");
		expect(result.ok && result.details?.reused).toBe(true);
		expect(result.ok && result.details?.lifecycle).toBe("fresh-respawned");
	});

	test("creates new staging window when no idle pane available", async () => {
		mockNewStagingWindow();

		const result = await actionRun("test-abc", {
			command: "npm start",
			cwd: "/tmp/project",
			windowReuse: "last",
			maxWindows: 10,
			autoFocus: "never",
			defaultLayout: "split-vertical",
			shellMode: "fresh",
			host: defaultHost,
		});

		expect(result.ok).toBe(true);
		expect(result.message).toContain("Started fresh pane");
		expect(result.ok && result.details?.created).toBe(true);
		expect(result.ok && result.details?.lifecycle).toBe("fresh-created");
	});

	test("rejects when maxWindows reached", async () => {
		mockTmuxInventory();

		const result = await actionRun("test-abc", {
			command: "npm run build",
			cwd: "/tmp/project",
			windowReuse: "never",
			maxWindows: 3,
			autoFocus: "never",
			defaultLayout: "split-vertical",
			shellMode: "fresh",
			host: defaultHost,
		});

		expect(result.ok).toBe(false);
		expect(result.message).toContain("panes open");
	});

	test("resume sends to the visible managed pane by default", async () => {
		mockTmuxInventory();

		const result = await actionRun("test-abc", {
			command: "npm test",
			cwd: "/tmp/project",
			windowReuse: "last",
			maxWindows: 10,
			autoFocus: "never",
			defaultLayout: "split-vertical",
			shellMode: "resume",
			host: defaultHost,
		});

		expect(result.ok).toBe(true);
		expect(result.message).toContain("Resumed pane %42");
		expect(result.ok && result.details?.lifecycle).toBe("resume-existing");
		expect(execSyncMock.mock.calls.some((args) => String(args[0]).includes("send-keys -t %42"))).toBe(true);
		expect(execSyncMock.mock.calls.some((args) => String(args[0]).includes("swap-pane"))).toBe(false);
	});

	test("uses custom name when provided", async () => {
		mockStagingWithIdlePane();

		const result = await actionRun("test-abc", {
			command: "npm start",
			name: "my-server",
			cwd: "/tmp/project",
			windowReuse: "last",
			maxWindows: 10,
			autoFocus: "never",
			defaultLayout: "split-vertical",
			shellMode: "fresh",
			host: defaultHost,
		});

		expect(result.ok).toBe(true);
		expect(result.message).toContain("my-server");
	});
});

describe("actionFocus()", () => {
	beforeEach(() => execSyncMock.mockReset());

	test("returns error for dead session", () => {
		mockDeadSession();
		const result = actionFocus("dead-sess", 0, defaultHost);
		expect(result.ok).toBe(false);
	});

	test("swaps the target pane into the view by pane ID (single swap)", () => {
		mockTmuxInventory();

		const result = actionFocus("test-abc", "logs", defaultHost);
		expect(result.ok).toBe(true);
		expect(result.message).toContain("Focused pane %51");
		// Single swap: swap view pane with the target pane by ID
		const calls = execSyncMock.mock.calls.map((args) => String(args[0]));
		const singleSwap = calls.filter((c) => c.includes("swap-pane -d -s =5:0.1 -t %51"));
		expect(singleSwap.length).toBe(1);
		// No return swap — only one swap call total
		const allSwaps = calls.filter((c) => c.includes("swap-pane"));
		expect(allSwaps.length).toBe(1);
	});

	test("reports already visible for the current view pane", () => {
		mockTmuxInventory();

		const result = actionFocus("test-abc", "build", defaultHost);
		expect(result.ok).toBe(true);
		expect(result.message).toContain("already visible");
	});
});

describe("actionClose()", () => {
	beforeEach(() => execSyncMock.mockReset());

	test("returns error for dead session", () => {
		mockDeadSession();
		const result = actionClose("dead-sess", 0, defaultHost);
		expect(result.ok).toBe(false);
	});

	test("kills view pane for a visible pane", () => {
		mockTmuxInventory();

		const result = actionClose("test-abc", "build", defaultHost);
		expect(result.ok).toBe(true);
		expect(execSyncMock.mock.calls.some((args) => String(args[0]).includes("kill-pane -t =5:0.1"))).toBe(true);
		// No staging window kill — pane identity is by @pi_name, not window
		expect(execSyncMock.mock.calls.some((args) => String(args[0]).includes("kill-window"))).toBe(false);
	});

	test("kills pane by ID for a non-visible pane", () => {
		mockTmuxInventory();

		const result = actionClose("test-abc", "logs", defaultHost);
		expect(result.ok).toBe(true);
		expect(execSyncMock.mock.calls.some((args) => String(args[0]).includes("kill-pane -t %51"))).toBe(true);
	});
});

describe("actionPeek()", () => {
	beforeEach(() => execSyncMock.mockReset());

	test("returns error for dead session", () => {
		mockDeadSession();
		const result = actionPeek("dead-sess", "all", defaultHost);
		expect(result.ok).toBe(false);
	});

	test("captures the visible pane output for the visible staging window", () => {
		mockTmuxInventory();

		const result = actionPeek("test-abc", "build", defaultHost);
		expect(result.ok).toBe(true);
		expect(result.message).toContain("visible build output");
		expect(execSyncMock.mock.calls.some((args) => String(args[0]).includes("capture-pane -t %42"))).toBe(true);
	});

	test("captures all panes output", () => {
		mockTmuxInventory();

		const result = actionPeek("test-abc", "all", defaultHost);
		expect(result.ok).toBe(true);
		expect(result.message).toContain("captured logs");
		expect(result.message).toContain("visible build output");
	});

	test("reports truncation metadata when output exceeds limit", () => {
		// Generate 100 lines of output
		const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
		execSyncMock.mockImplementation((_cmd?: string) => {
			const cmd = _cmd ?? "";
			if (cmd.includes("has-session -t =test-abc-stg")) return "ok\n";
			if (cmd.includes("list-panes -t =5:0 -F \"#{pane_index} #{pane_id}\"")) return "0 %1\n1 %42\n";
			if (cmd.includes("list-panes -t =5:0 -F \"#{pane_index}\t#{pane_id}\t#{pane_current_command}\t#{pane_pid}\"")) return "0\t%1\tzsh\t1001\n1\t%42\tzsh\t4242\n";
			if (cmd.includes("display -p -t %42 \"#{@pi_name}\"")) return "build\n";
			if (cmd.includes("list-panes -s -t =test-abc-stg")) return "";
			if (cmd.includes("pgrep -P 4242")) throw new Error("no children");
			if (cmd.includes("capture-pane -t %42")) return lines.join("\n") + "\n";
			return "\n";
		});

		// Peek with limit=10 — should report truncation
		const result = actionPeek("test-abc", "build", defaultHost, 10);
		expect(result.ok).toBe(true);
		expect(result.message).toContain("100 lines total, showing last 10");
		expect(result.message).toContain("line 100");
		expect(result.message).not.toContain("line 1\n");
	});

	test("no truncation metadata when output fits within limit", () => {
		execSyncMock.mockImplementation((_cmd?: string) => {
			const cmd = _cmd ?? "";
			if (cmd.includes("has-session -t =test-abc-stg")) return "ok\n";
			if (cmd.includes("list-panes -t =5:0 -F \"#{pane_index} #{pane_id}\"")) return "0 %1\n1 %42\n";
			if (cmd.includes("list-panes -t =5:0 -F \"#{pane_index}\t#{pane_id}\t#{pane_current_command}\t#{pane_pid}\"")) return "0\t%1\tzsh\t1001\n1\t%42\tzsh\t4242\n";
			if (cmd.includes("display -p -t %42 \"#{@pi_name}\"")) return "build\n";
			if (cmd.includes("list-panes -s -t =test-abc-stg")) return "";
			if (cmd.includes("pgrep -P 4242")) throw new Error("no children");
			if (cmd.includes("capture-pane -t %42")) return "short output\n";
			return "\n";
		});

		const result = actionPeek("test-abc", "build", defaultHost);
		expect(result.ok).toBe(true);
		expect(result.message).toContain("short output");
		expect(result.message).not.toContain("lines total");
	});
});

describe("actionList()", () => {
	beforeEach(() => execSyncMock.mockReset());

	test("returns error for dead session", () => {
		mockDeadSession();
		const result = actionList("dead-sess", defaultHost);
		expect(result.ok).toBe(false);
	});

	test("reports managed panes with stable names from @pi_name", () => {
		mockTmuxInventory();

		const result = actionList("test-abc", defaultHost);
		expect(result.ok).toBe(true);
		expect(result.message).toContain("managed pane(s)");
		// build is visible (from view pane @pi_name), logs and ci from staging
		expect(result.message).toContain("build");
		expect(result.message).toContain("(visible, idle, pane %42)");
		expect(result.message).toContain("logs");
		expect(result.message).toContain("(offscreen, running, pane %51)");
		expect(result.message).toContain("ci");
		expect(result.message).toContain("(offscreen, idle, pane %77)");
	});
});

describe("actionKill()", () => {
	beforeEach(() => execSyncMock.mockReset());

	test("returns error for dead session", () => {
		mockDeadSession();
		const result = actionKill("dead-sess", defaultHost);
		expect(result.ok).toBe(false);
	});

	test("kills staging session and view pane", () => {
		mockTmuxInventory();

		const result = actionKill("test-abc", defaultHost);
		expect(result.ok).toBe(true);
		expect(result.message).toContain("Killed");
		expect(execSyncMock.mock.calls.some((args) => String(args[0]).includes("kill-pane -t =5:0.1"))).toBe(true);
		expect(execSyncMock.mock.calls.some((args) => String(args[0]).includes("kill-session -t =test-abc-stg"))).toBe(true);
	});
});

describe("actionClear()", () => {
	beforeEach(() => execSyncMock.mockReset());

	test("returns error for dead session", () => {
		mockDeadSession();
		const result = actionClear("dead-sess", defaultHost);
		expect(result.ok).toBe(false);
	});

	test("clears idle panes by pane ID", () => {
		mockTmuxInventory();

		const result = actionClear("test-abc", defaultHost);
		expect(result.ok).toBe(true);
		// build (visible, idle) killed via view pane, ci (offscreen, idle) killed by pane ID
		// logs (running) kept
		expect(result.message).toContain("Cleared 2 idle pane(s)");
		expect(execSyncMock.mock.calls.some((args) => String(args[0]).includes("kill-pane -t =5:0.1"))).toBe(true);
		expect(execSyncMock.mock.calls.some((args) => String(args[0]).includes("kill-pane -t %77"))).toBe(true);
	});

	test("reports no idle panes when all are running", () => {
		execSyncMock.mockImplementation((_cmd?: string) => {
			const cmd = _cmd ?? "";
			if (cmd.includes("has-session -t =test-abc-stg")) return "ok\n";
			if (cmd.includes("list-panes -t =5:0 -F \"#{pane_index} #{pane_id}\"")) return "0 %1\n1 %42\n";
			if (cmd.includes("list-panes -t =5:0 -F \"#{pane_index}\t#{pane_id}\t#{pane_current_command}\t#{pane_pid}\"")) return "0\t%1\tzsh\t1001\n1\t%42\tnode\t4242\n";
			if (cmd.includes("display -p -t %42 \"#{@pi_name}\"")) return "dev\n";
			if (cmd.includes("list-panes -s -t =test-abc-stg")) return "0\t%50\tnode\t5050\tserver\n";
			if (cmd.includes("pgrep -P 4242")) return "4243\n";
			if (cmd.includes("pgrep -P 5050")) return "5051\n";
			return "\n";
		});

		const result = actionClear("test-abc", defaultHost);
		expect(result.ok).toBe(true);
		expect(result.message).toContain("No idle panes");
	});
});

describe("actionMute()", () => {
	beforeEach(() => execSyncMock.mockReset());

	test("returns error for dead session", () => {
		mockDeadSession();
		const result = actionMute("dead-sess", 0, defaultHost);
		expect(result.ok).toBe(false);
	});

	test("mutes silence alerts for a managed pane", () => {
		mockTmuxInventory();

		const result = actionMute("test-abc", "build", defaultHost);
		expect(result.ok).toBe(true);
		expect(result.message).toContain("Muted");
		expect(result.message).toContain("build");
	});
});

describe("actionAttach()", () => {
	beforeEach(() => execSyncMock.mockReset());

	test("returns error for dead session", () => {
		mockDeadSession();
		const result = actionAttach("dead-sess", "/tmp", { layout: "split-vertical", host: defaultHost });
		expect(result.ok).toBe(false);
		expect(result.message).toContain("No active session");
	});

	test("reports already attached when view pane exists", () => {
		mockTmuxInventory();
		(hasAttachedPane as ReturnType<typeof mock>).mockReturnValueOnce(true);

		const result = actionAttach("test-abc", "/tmp", { layout: "split-vertical", host: defaultHost });
		expect(result.ok).toBe(true);
		expect(result.message).toContain("Already attached");
	});
});

describe("ActionResult consistency", () => {
	beforeEach(() => execSyncMock.mockReset());

	test("all actions return ok: false for dead sessions", () => {
		mockDeadSession();

		const results = [
			actionAttach("dead", "/tmp", { layout: "split-vertical", host: defaultHost }),
			actionFocus("dead", 0, defaultHost),
			actionClose("dead", 0, defaultHost),
			actionPeek("dead", "all", defaultHost),
			actionList("dead", defaultHost),
			actionKill("dead", defaultHost),
			actionClear("dead", defaultHost),
			actionMute("dead", 0, defaultHost),
		];

		for (const r of results) {
			expect(r.ok).toBe(false);
			expect(r.message).toBeTruthy();
		}
	});
});
