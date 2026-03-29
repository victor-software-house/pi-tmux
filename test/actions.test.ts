import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";

// Ensure tests run as if outside tmux regardless of the host environment
delete process.env.TMUX;

// Mock execSync before importing actions
// biome-ignore: test mock needs flexible signature
const execSyncMock = mock((_cmd?: string) => "");
mock.module("node:child_process", () => ({
	execSync: execSyncMock,
}));

// Mock terminal module (no iTerm in tests)
mock.module("../extensions/terminal.js", () => ({
	attachToSession: mock(() => "Attached to session"),
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
import { hasAttachedPane } from "../extensions/terminal.js";

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

// Helper: standard "alive session with 2 windows" mock
function mockAliveSession(_session: string): void {
	mockCommands({
		"has-session": "ok\n",
		"list-windows": `0\tdev-server\t0\n1\ttest-suite\t1\n`,
		"select-window": "\n",
		"kill-window": "\n",
		"kill-session": "\n",
		"capture-pane": "some output\n",
		"new-window": "\n",
		"send-keys": "\n",
		"rename-window": "\n",
		"new-session": "\n",
		"pane_current_command": "zsh\n",
		"pgrep": "",
	});
}

function mockDeadSession(): void {
	execSyncMock.mockImplementation(() => {
		throw new Error("no session");
	});
}

describe("actionRun()", () => {
	beforeEach(() => execSyncMock.mockReset());

	test("creates new session when none exists", async () => {
		let sessionCreated = false;
		execSyncMock.mockImplementation((_cmd?: string) => {
			const cmd = _cmd ?? "";
			if (cmd.includes("has-session")) throw new Error("no session");
			if (cmd.includes("new-session")) { sessionCreated = true; return "\n"; }
			if (cmd.includes("rename-window")) return "\n";
			if (cmd.includes("send-keys")) return "\n";
			return "\n";
		});

		const result = await actionRun("test-abc", {
			command: "npm start",
			cwd: "/tmp/project",
			windowReuse: "last",
			maxWindows: 10,
			autoFocus: "never", defaultLayout: "split-vertical", shellMode: "fresh",
		});

		expect(result.ok).toBe(true);
		expect(result.message).toContain("Created");
		expect(result.message).toContain("npm start");
		expect(sessionCreated).toBe(true);
		expect(result.ok && result.details?.created).toBe(true);
	});

	test("reuses idle window with windowReuse: last", async () => {
		let renamedWindow = false;
		let sentKeys = false;
		execSyncMock.mockImplementation((_cmd?: string) => {
			const cmd = _cmd ?? "";
			if (cmd.includes("has-session")) return "ok\n";
			if (cmd.includes("list-windows") && cmd.includes("pane_current_command")) return "0\tzsh\t1234\n";
			if (cmd.includes("list-windows")) return "0\tdev-server\t0\n";
			if (cmd.includes("pgrep")) throw new Error("no children");
			if (cmd.includes("rename-window")) { renamedWindow = true; return "\n"; }
			if (cmd.includes("send-keys")) { sentKeys = true; return "\n"; }
			return "\n";
		});

		const result = await actionRun("test-abc", {
			command: "npm test",
			cwd: "/tmp/project",
			windowReuse: "last",
			maxWindows: 10,
			autoFocus: "never", defaultLayout: "split-vertical", shellMode: "fresh",
		});

		expect(result.ok).toBe(true);
		expect(result.message).toContain("Reused");
		expect(renamedWindow).toBe(true);
		expect(sentKeys).toBe(true);
		expect(result.ok && result.details?.reused).toBe(true);
	});

	test("rejects when maxWindows reached", async () => {
		execSyncMock.mockImplementation((_cmd?: string) => {
			const cmd = _cmd ?? "";
			if (cmd.includes("has-session")) return "ok\n";
			if (cmd.includes("list-windows")) return "0\tdev\t0\n1\ttest\t0\n";
			if (cmd.includes("pane_current_command")) return "node\n";
			return "\n";
		});

		const result = await actionRun("test-abc", {
			command: "npm run build",
			cwd: "/tmp/project",
			windowReuse: "last",
			maxWindows: 2,
			autoFocus: "never", defaultLayout: "split-vertical", shellMode: "fresh",
		});

		expect(result.ok).toBe(false);
		expect(result.message).toContain("2 windows open");
	});

	test("respects windowReuse: never", async () => {
		let createdWindow = false;
		execSyncMock.mockImplementation((_cmd?: string) => {
			const cmd = _cmd ?? "";
			if (cmd.includes("has-session")) return "ok\n";
			if (cmd.includes("list-windows")) return "0\tdev\t0\n";
			if (cmd.includes("pane_current_command")) return "zsh\n";
			if (cmd.includes("new-window")) { createdWindow = true; return "\n"; }
			if (cmd.includes("rename-window")) return "\n";
			if (cmd.includes("send-keys")) return "\n";
			return "\n";
		});

		const result = await actionRun("test-abc", {
			command: "npm test",
			cwd: "/tmp/project",
			windowReuse: "never",
			maxWindows: 10,
			autoFocus: "never", defaultLayout: "split-vertical", shellMode: "fresh",
		});

		expect(result.ok).toBe(true);
		expect(result.message).toContain("Added to");
		expect(createdWindow).toBe(true);
	});

	test("uses custom name when provided", async () => {
		execSyncMock.mockImplementation((_cmd?: string) => {
			const cmd = _cmd ?? "";
			if (cmd.includes("has-session")) throw new Error("no session");
			if (cmd.includes("new-session")) return "\n";
			if (cmd.includes("rename-window")) return "\n";
			if (cmd.includes("send-keys")) return "\n";
			return "\n";
		});

		const result = await actionRun("test-abc", {
			command: "npm start",
			name: "my-server",
			cwd: "/tmp/project",
			windowReuse: "last",
			maxWindows: 10,
			autoFocus: "never", defaultLayout: "split-vertical", shellMode: "fresh",
		});

		expect(result.ok).toBe(true);
		expect(result.message).toContain("my-server");
	});
});

describe("tmux mode", () => {
	beforeEach(() => {
		execSyncMock.mockReset();
		process.env.TMUX = "cc";
	});

	afterEach(() => {
		delete process.env.TMUX;
	});

	function mockTmuxInventory(): void {
		execSyncMock.mockImplementation((_cmd?: string) => {
			const cmd = _cmd ?? "";
			if (cmd.includes("has-session -t =test-abc-stg")) return "ok\n";
			if (cmd.includes("list-panes -t =5:0 -F \"#{pane_index} #{pane_id}\"")) return "0 %1\n1 %42\n";
			if (cmd.includes("list-panes -t =5:0 -F \"#{pane_index}\t#{pane_id}\t#{pane_current_command}\t#{pane_pid}\"")) return "0\t%1\tzsh\t1001\n1\t%42\tzsh\t4242\n";
			if (cmd.includes("display -p -t =5:0 \"#{@pi_visible_owner_session}\t#{@pi_visible_staging_window}\"")) return "test-abc\t1\n";
			if (cmd.includes("list-panes -t =test-abc-stg -F \"#{window_index}\t#{window_name}\t#{pane_id}\t#{pane_current_command}\t#{pane_pid}\"")) {
				return "0\tlogs\t%51\tnode\t5151\n1\tbuild\t%99\tzsh\t9999\n2\tci\t%77\tbash\t7777\n";
			}
			if (cmd.includes("pgrep -P 4242")) throw new Error("no children");
			if (cmd.includes("pgrep -P 5151")) return "5152\n";
			if (cmd.includes("pgrep -P 7777")) throw new Error("no children");
			if (cmd.includes("send-keys -t %42")) return "\n";
			if (cmd.includes("capture-pane -t %42")) return "visible build output\n";
			if (cmd.includes("capture-pane -t %51")) return "captured logs\n";
			if (cmd.includes("swap-pane -d -s =5:0.1 -t =test-abc-stg:0.0")) return "\n";
			if (cmd.includes("swap-pane -d -s =5:0.1 -t =test-abc-stg:1.0")) return "\n";
			if (cmd.includes("set-window-option -t =5:0 @pi_visible_staging_window 0")) return "\n";
			if (cmd.includes("set-window-option -t =5:0 @pi_visible_owner_session \"test-abc\"")) return "\n";
			if (cmd.includes("set-window-option -u -t =5:0 @pi_visible_staging_window")) return "\n";
			if (cmd.includes("set-window-option -u -t =5:0 @pi_visible_owner_session")) return "\n";
			if (cmd.includes("kill-pane -t =test-abc-stg:1.0")) return "\n";
			return "\n";
		});
	}

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
			hostSession: "5",
		});

		expect(result.ok).toBe(true);
		expect(result.message).toContain("Resumed pane %42");
		expect(result.ok && result.details?.lifecycle).toBe("resume-existing");
		expect(execSyncMock.mock.calls.some((args) => String(args[0]).includes("send-keys -t %42"))).toBe(true);
		expect(execSyncMock.mock.calls.some((args) => String(args[0]).includes("swap-pane"))).toBe(false);
	});

	test("focus swaps an offscreen staging window into view by stable window identity", () => {
		mockTmuxInventory();

		const result = actionFocus("test-abc", "logs", "5");
		expect(result.ok).toBe(true);
		expect(result.message).toContain("Focused pane %51");
		expect(execSyncMock.mock.calls.some((args) => String(args[0]).includes("swap-pane -d -s =5:0.1 -t =test-abc-stg:0.0"))).toBe(true);
		expect(execSyncMock.mock.calls.some((args) => String(args[0]).includes("@pi_visible_staging_window 0"))).toBe(true);
	});

	test("peek captures the visible pane output for the visible staging window", () => {
		mockTmuxInventory();

		const result = actionPeek("test-abc", "build", "5");
		expect(result.ok).toBe(true);
		expect(result.message).toContain("visible build output");
		expect(execSyncMock.mock.calls.some((args) => String(args[0]).includes("capture-pane -t %42"))).toBe(true);
	});

	test("list reports staging window indices with stable names", () => {
		mockTmuxInventory();

		const result = actionList("test-abc", "5");
		expect(result.ok).toBe(true);
		expect(result.message).toContain("managed pane(s)");
		expect(result.message).toContain(":1  build  (visible, idle, pane %42)");
		expect(result.message).toContain(":0  logs  (offscreen, running, pane %51)");
	});

	test("close swaps a visible pane back to staging before killing it", () => {
		mockTmuxInventory();

		const result = actionClose("test-abc", "build", "5");
		expect(result.ok).toBe(true);
		expect(execSyncMock.mock.calls.some((args) => String(args[0]).includes("swap-pane -d -s =5:0.1 -t =test-abc-stg:1.0"))).toBe(true);
		expect(execSyncMock.mock.calls.some((args) => String(args[0]).includes("kill-pane -t =test-abc-stg:1.0"))).toBe(true);
	});
});

describe("actionAttach()", () => {
	beforeEach(() => execSyncMock.mockReset());

	test("returns error for dead session", () => {
		mockDeadSession();
		const result = actionAttach("dead-sess", "/tmp", { layout: "split-vertical" });
		expect(result.ok).toBe(false);
		expect(result.message).toContain("No active session");
	});

	test("reports already attached when pane exists", () => {
		mockAliveSession("test-sess");
		(hasAttachedPane as ReturnType<typeof mock>).mockReturnValueOnce(true);

		const result = actionAttach("test-sess", "/tmp", { layout: "split-vertical" });
		expect(result.ok).toBe(true);
		expect(result.message).toContain("Already attached");
	});
});

describe("actionFocus()", () => {
	beforeEach(() => execSyncMock.mockReset());

	test("returns error for dead session", () => {
		mockDeadSession();
		const result = actionFocus("dead-sess", 0);
		expect(result.ok).toBe(false);
	});

	test("switches window on alive session", () => {
		let selectedWindow = false;
		execSyncMock.mockImplementation((_cmd?: string) => {
			const cmd = _cmd ?? "";
			if (cmd.includes("has-session")) return "ok\n";
			if (cmd.includes("list-windows")) return "0\tdev\t0\n1\ttest\t0\n";
			if (cmd.includes("select-window")) { selectedWindow = true; return "\n"; }
			return "\n";
		});

		const result = actionFocus("test-sess", 1);
		expect(result.ok).toBe(true);
		expect(result.message).toContain(":1");
		expect(selectedWindow).toBe(true);
	});
});

describe("actionClose()", () => {
	beforeEach(() => execSyncMock.mockReset());

	test("returns error for dead session", () => {
		mockDeadSession();
		const result = actionClose("dead-sess", 0);
		expect(result.ok).toBe(false);
	});

	test("kills window and reports remaining", () => {
		let killed = false;
		execSyncMock.mockImplementation((_cmd?: string) => {
			const cmd = _cmd ?? "";
			if (cmd.includes("has-session")) return "ok\n";
			if (cmd.includes("list-windows")) return killed ? "1\ttest\t0\n" : "0\tdev\t0\n1\ttest\t0\n";
			if (cmd.includes("kill-window")) { killed = true; return "\n"; }
			return "\n";
		});

		const result = actionClose("test-sess", 0);
		expect(result.ok).toBe(true);
		expect(result.message).toContain("Closed :0");
		expect(result.message).toContain("1 window(s) remain");
	});
});

describe("actionPeek()", () => {
	beforeEach(() => execSyncMock.mockReset());

	test("returns error for dead session", () => {
		mockDeadSession();
		const result = actionPeek("dead-sess", "all");
		expect(result.ok).toBe(false);
	});

	test("captures output from session", () => {
		execSyncMock.mockImplementation((_cmd?: string) => {
			const cmd = _cmd ?? "";
			if (cmd.includes("has-session")) return "ok\n";
			if (cmd.includes("list-windows")) return "0\tdev\t0\n";
			if (cmd.includes("capture-pane")) return "hello world\n";
			return "\n";
		});

		const result = actionPeek("test-sess", "all");
		expect(result.ok).toBe(true);
		expect(result.message).toContain("hello world");
	});
});

describe("actionList()", () => {
	beforeEach(() => execSyncMock.mockReset());

	test("returns error for dead session", () => {
		mockDeadSession();
		const result = actionList("dead-sess");
		expect(result.ok).toBe(false);
	});

	test("lists windows", () => {
		mockAliveSession("test-sess");
		const result = actionList("test-sess");
		expect(result.ok).toBe(true);
		expect(result.message).toContain("dev-server");
		expect(result.message).toContain("test-suite");
		expect(result.message).toContain("2 window(s)");
	});
});

describe("actionKill()", () => {
	beforeEach(() => execSyncMock.mockReset());

	test("returns error for dead session", () => {
		mockDeadSession();
		const result = actionKill("dead-sess");
		expect(result.ok).toBe(false);
	});

	test("kills session", () => {
		let killed = false;
		execSyncMock.mockImplementation((_cmd?: string) => {
			const cmd = _cmd ?? "";
			if (cmd.includes("has-session")) return killed ? (() => { throw new Error("dead"); })() : "ok\n";
			if (cmd.includes("kill-session")) { killed = true; return "\n"; }
			return "\n";
		});

		const result = actionKill("test-sess");
		expect(result.ok).toBe(true);
		expect(result.message).toContain("Killed");
	});
});

describe("actionClear()", () => {
	beforeEach(() => execSyncMock.mockReset());

	test("returns error for dead session", () => {
		mockDeadSession();
		const result = actionClear("dead-sess");
		expect(result.ok).toBe(false);
	});

	test("clears idle windows", () => {
		let killCount = 0;
		execSyncMock.mockImplementation((_cmd?: string) => {
			const cmd = _cmd ?? "";
			if (cmd.includes("has-session")) return "ok\n";
			if (cmd.includes("list-windows") && cmd.includes("pane_current_command"))
				return "0\tzsh\t1234\n1\tnode\t5678\n";
			if (cmd.includes("list-windows")) return "1\tnode\t0\n";
			if (cmd.includes("pgrep -P 1234")) throw new Error("no children");
			if (cmd.includes("pgrep -P 5678")) return "5679\n";
			if (cmd.includes("kill-window")) { killCount++; return "\n"; }
			return "\n";
		});

		const result = actionClear("test-sess");
		expect(result.ok).toBe(true);
		expect(result.message).toContain("Cleared 1 idle window");
		expect(killCount).toBe(1);
	});

	test("reports no idle windows", () => {
		execSyncMock.mockImplementation((_cmd?: string) => {
			const cmd = _cmd ?? "";
			if (cmd.includes("has-session")) return "ok\n";
			if (cmd.includes("list-windows") && cmd.includes("pane_current_command"))
				return "0\tnode\t1234\n";
			if (cmd.includes("pgrep")) return "1235\n";
			return "\n";
		});

		const result = actionClear("test-sess");
		expect(result.ok).toBe(true);
		expect(result.message).toContain("No idle windows");
	});
});

describe("actionMute()", () => {
	beforeEach(() => execSyncMock.mockReset());

	test("returns error for dead session", () => {
		mockDeadSession();
		const result = actionMute("dead-sess", 0);
		expect(result.ok).toBe(false);
	});

	test("mutes window silence alerts", () => {
		mockAliveSession("test-sess");
		const result = actionMute("test-sess", 0);
		expect(result.ok).toBe(true);
		expect(result.message).toContain("Muted");
		expect(result.message).toContain(":0");
	});
});

describe("ActionResult consistency", () => {
	beforeEach(() => execSyncMock.mockReset());

	test("all actions return ok: false for dead sessions", () => {
		mockDeadSession();

		const results = [
			actionAttach("dead", "/tmp", { layout: "split-vertical" }),
			actionFocus("dead", 0),
			actionClose("dead", 0),
			actionPeek("dead", "all"),
			actionList("dead"),
			actionKill("dead"),
			actionClear("dead"),
			actionMute("dead", 0),
		];

		for (const r of results) {
			expect(r.ok).toBe(false);
			expect(r.message).toBeTruthy();
		}
	});
});
