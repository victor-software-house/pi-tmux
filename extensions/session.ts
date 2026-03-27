/**
 * tmux session management — exec helpers, session naming, window queries.
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import type { WindowInfo } from "./types.js";

export function exec(cmd: string): string {
	return execSync(cmd, { encoding: "utf-8", timeout: 10000 }).trim();
}

export function execSafe(cmd: string): string | null {
	try {
		return exec(cmd);
	} catch {
		return null;
	}
}

function getGitRoot(cwd: string): string | null {
	try {
		return execSync("git rev-parse --show-toplevel", {
			encoding: "utf-8",
			cwd,
			timeout: 5000,
		}).trim();
	} catch {
		return null;
	}
}

/** Prefers git root, falls back to cwd so tmux works outside git repos. */
export function getProjectRoot(cwd: string): string {
	return getGitRoot(cwd) ?? cwd;
}

export function sessionName(root: string): string {
	const slug = (root.split("/").pop() ?? "shell").slice(0, 16).toLowerCase();
	const hash = createHash("md5").update(root).digest("hex").slice(0, 8);
	return `${slug}-${hash}`;
}

export function sessionExists(name: string): boolean {
	return execSafe(`tmux has-session -t ${name} 2>/dev/null && echo yes`) === "yes";
}

export function getWindows(name: string): WindowInfo[] {
	const raw = execSafe(`tmux list-windows -t ${name} -F "#{window_index}|||#{window_name}|||#{window_active}"`);
	if (!raw) return [];
	return raw.split("\n").map((line) => {
		const [index, title, active] = line.split("|||");
		return { index: parseInt(index ?? "0"), title: title ?? "", active: active === "1" };
	});
}

export function capturePanes(name: string, window: number | "all"): string {
	if (window === "all") {
		const windows = getWindows(name);
		return windows
			.map((w) => {
				const output = execSafe(`tmux capture-pane -t ${name}:${w.index} -p -S -50`);
				return `── window ${w.index}: ${w.title} ──\n${output ?? "(empty)"}`;
			})
			.join("\n\n");
	}
	return execSafe(`tmux capture-pane -t ${name}:${window} -p -S -50`) ?? "(empty)";
}

export function escapeForTmux(s: string): string {
	return s.replace(/"/g, '\\"');
}
