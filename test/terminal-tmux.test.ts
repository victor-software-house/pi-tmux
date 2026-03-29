import { beforeEach, describe, expect, mock, test } from "bun:test";

const execSyncMock = mock((_cmd?: string) => "");
mock.module("node:child_process", () => ({
	execSync: execSyncMock,
}));

import { hasAttachedPane, openTerminal, closeAttachedSessions } from "../extensions/terminal-tmux.js";

describe("terminal-tmux", () => {
	beforeEach(() => {
		execSyncMock.mockReset();
	});

	test("hasAttachedPane verifies pane index 1 exists in the host session", () => {
		execSyncMock.mockImplementation((_cmd?: string) => {
			const cmd = _cmd ?? "";
			if (cmd.includes("list-panes -t =5:0 -F \"#{pane_index}\t#{pane_id}\"")) {
				return "0\t%1\n1\t%42\n";
			}
			return "\n";
		});

		expect(hasAttachedPane("5")).toBe(true);
	});

	test("hasAttachedPane returns false after the view split was closed", () => {
		let callCount = 0;
		execSyncMock.mockImplementation((_cmd?: string) => {
			const cmd = _cmd ?? "";
			if (cmd.includes("list-panes -t =5:0 -F \"#{pane_index}\t#{pane_id}\"")) {
				callCount += 1;
				return callCount === 1 ? "0\t%1\n1\t%42\n" : "0\t%1\n";
			}
			return "\n";
		});

		expect(hasAttachedPane("5")).toBe(true);
		expect(hasAttachedPane("5")).toBe(false);
	});

	test("openTerminal recreates the split when pane index 1 is missing", () => {
		let closed = false;
		execSyncMock.mockImplementation((_cmd?: string) => {
			const cmd = _cmd ?? "";
			if (cmd.includes("list-panes -t =5:0 -F \"#{pane_index}\t#{pane_id}\"")) {
				return closed ? "0\t%1\n" : "0\t%1\n1\t%42\n";
			}
			if (cmd.includes("split-window -h -t =5:0 -d -P -F \"#{pane_id}\"")) {
				return "%99\n";
			}
			return "\n";
		});

		expect(openTerminal("5", "split-vertical")).toBe("View pane already visible.");
		closed = true;
		expect(openTerminal("5", "split-vertical")).toBe("Opened vertical split (%99).");
	});

	test("closeAttachedSessions kills the tracked view pane", () => {
		let killedPane = "";
		execSyncMock.mockImplementation((_cmd?: string) => {
			const cmd = _cmd ?? "";
			if (cmd.includes("list-panes -t =5:0 -F \"#{pane_index}\t#{pane_id}\"")) {
				return "0\t%1\n1\t%42\n";
			}
			if (cmd.includes("kill-pane -t %42")) {
				killedPane = "%42";
				return "\n";
			}
			return "\n";
		});

		hasAttachedPane("5");
		closeAttachedSessions("5");
		expect(killedPane).toBe("%42");
	});
});
