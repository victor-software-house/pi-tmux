import { describe, expect, test, mock, beforeEach } from "bun:test";

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

	test("creates new session when none exists", () => {
		let sessionCreated = false;
		execSyncMock.mockImplementation((_cmd?: string) => {
			const cmd = _cmd ?? "";
			if (cmd.includes("has-session")) throw new Error("no session");
			if (cmd.includes("new-session")) { sessionCreated = true; return "\n"; }
			if (cmd.includes("rename-window")) return "\n";
			if (cmd.includes("send-keys")) return "\n";
			return "\n";
		});

		const result = actionRun("test-abc", {
			command: "npm start",
			cwd: "/tmp/project",
			windowReuse: "last",
			maxWindows: 10,
			autoFocus: "never",
		});

		expect(result.ok).toBe(true);
		expect(result.message).toContain("Created");
		expect(result.message).toContain("npm start");
		expect(sessionCreated).toBe(true);
		expect(result.ok && result.details?.created).toBe(true);
	});

	test("reuses idle window with windowReuse: last", () => {
		let renamedWindow = false;
		let sentKeys = false;
		execSyncMock.mockImplementation((_cmd?: string) => {
			const cmd = _cmd ?? "";
			if (cmd.includes("has-session")) return "ok\n";
			// isWindowIdle uses list-windows with pane_current_command format
			if (cmd.includes("list-windows") && cmd.includes("pane_current_command"))
				return "0\tzsh\t1234\n";
			if (cmd.includes("list-windows")) return "0\tdev-server\t0\n";
			if (cmd.includes("pgrep")) throw new Error("no children");
			if (cmd.includes("rename-window")) { renamedWindow = true; return "\n"; }
			if (cmd.includes("send-keys")) { sentKeys = true; return "\n"; }
			return "\n";
		});

		const result = actionRun("test-abc", {
			command: "npm test",
			cwd: "/tmp/project",
			windowReuse: "last",
			maxWindows: 10,
			autoFocus: "never",
		});

		expect(result.ok).toBe(true);
		expect(result.message).toContain("Reused");
		expect(renamedWindow).toBe(true);
		expect(sentKeys).toBe(true);
		expect(result.ok && result.details?.reused).toBe(true);
	});

	test("rejects when maxWindows reached", () => {
		execSyncMock.mockImplementation((_cmd?: string) => {
			const cmd = _cmd ?? "";
			if (cmd.includes("has-session")) return "ok\n";
			if (cmd.includes("list-windows")) return "0\tdev\t0\n1\ttest\t0\n";
			// Both windows busy
			if (cmd.includes("pane_current_command")) return "node\n";
			return "\n";
		});

		const result = actionRun("test-abc", {
			command: "npm run build",
			cwd: "/tmp/project",
			windowReuse: "last",
			maxWindows: 2,
			autoFocus: "never",
		});

		expect(result.ok).toBe(false);
		expect(result.message).toContain("2 windows open");
	});

	test("respects windowReuse: never", () => {
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

		const result = actionRun("test-abc", {
			command: "npm test",
			cwd: "/tmp/project",
			windowReuse: "never",
			maxWindows: 10,
			autoFocus: "never",
		});

		expect(result.ok).toBe(true);
		expect(result.message).toContain("Added to");
		expect(createdWindow).toBe(true);
	});

	test("uses custom name when provided", () => {
		execSyncMock.mockImplementation((_cmd?: string) => {
			const cmd = _cmd ?? "";
			if (cmd.includes("has-session")) throw new Error("no session");
			if (cmd.includes("new-session")) return "\n";
			if (cmd.includes("rename-window")) return "\n";
			if (cmd.includes("send-keys")) return "\n";
			return "\n";
		});

		const result = actionRun("test-abc", {
			command: "npm start",
			name: "my-server",
			cwd: "/tmp/project",
			windowReuse: "last",
			maxWindows: 10,
			autoFocus: "never",
		});

		expect(result.ok).toBe(true);
		expect(result.message).toContain("my-server");
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
