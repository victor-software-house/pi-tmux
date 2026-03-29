import { beforeEach, describe, expect, mock, test } from "bun:test";

delete process.env.TMUX;

// biome-ignore: test mock needs flexible signature
const execSyncMock = mock((_cmd?: string) => "");
mock.module("node:child_process", () => ({
	execSync: execSyncMock,
}));

import { openTerminal } from "../extensions/terminal-legacy.js";

describe("terminal-legacy openTerminal()", () => {
	beforeEach(() => {
		execSyncMock.mockReset();
	});

	test("quotes exact tmux targets when opening Terminal.app", () => {
		process.env.TERM_PROGRAM = "Apple_Terminal";
		execSyncMock.mockImplementation(() => "\n");

		const result = openTerminal("pi-tmux-be23e752", "tab");

		expect(result).toContain("Opened Terminal.app window attached to pi-tmux-be23e752.");
		expect(execSyncMock.mock.calls.some((args) => String(args[0]).includes("tmux attach -t '=pi-tmux-be23e752'"))).toBe(true);
	});

	test("shows a shell-safe manual command for unsupported terminals", () => {
		process.env.TERM_PROGRAM = "Unknown Terminal";

		const result = openTerminal("pi-tmux-be23e752", "tab");

		expect(result).toContain("tmux attach -t '=pi-tmux-be23e752'");
	});
});
