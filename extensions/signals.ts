/**
 * Signal file watcher — detects command completion and silence alerts.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { watch as chokidarWatch, type FSWatcher } from "chokidar";
import type { SilenceConfig } from "./types.js";
import { exec, execSafe, getWindows, escapeForTmux } from "./session.js";

const SIGNAL_BASE = "/tmp/pi-tmux";

let SIGNAL_DIR: string | null = null;
let watcher: FSWatcher | null = null;

/** Per-window silence backoff state, keyed by "session.windowIndex.id" */
const silenceState = new Map<string, { current: number; factor: number; cap: number }>();

export function getSignalDir(): string {
	if (!SIGNAL_DIR) {
		SIGNAL_DIR = join(SIGNAL_BASE, randomBytes(8).toString("hex"));
		mkdirSync(SIGNAL_DIR, { recursive: true });
	}
	return SIGNAL_DIR;
}

export function initSignalDir(sessionFile: string | null | undefined): void {
	const id = sessionFile ? createHash("md5").update(sessionFile).digest("hex").slice(0, 16) : randomBytes(8).toString("hex");
	SIGNAL_DIR = join(SIGNAL_BASE, id);
	mkdirSync(SIGNAL_DIR, { recursive: true });
}

export function registerSilence(session: string, windowIndex: number, windowId: string, silence: SilenceConfig): void {
	silenceState.set(`${session}.${windowIndex}.${windowId}`, {
		current: silence.timeout,
		factor: silence.factor,
		cap: silence.cap,
	});
}

function parseSignalFilename(filename: string): { session: string; winIdx: number; id: string } | null {
	const lastDot = filename.lastIndexOf(".");
	const secondLastDot = filename.lastIndexOf(".", lastDot - 1);
	if (secondLastDot === -1) return null;
	const session = filename.slice(0, secondLastDot);
	const winStr = filename.slice(secondLastDot + 1, lastDot);
	const winIdx = parseInt(winStr);
	if (isNaN(winIdx)) return null;
	const id = filename.slice(lastDot + 1);
	return { session, winIdx, id };
}

function handleCompletionSignal(pi: ExtensionAPI, filepath: string, filename: string): void {
	const exitCode = readFileSync(filepath, "utf-8").trim();
	unlinkSync(filepath);

	const parsed = parseSignalFilename(filename);
	if (!parsed) return;
	const { session, winIdx, id } = parsed;

	const silenceKey = `${session}.${winIdx}.${id}`;
	if (silenceState.has(silenceKey)) {
		silenceState.delete(silenceKey);
		execSafe(`tmux set-option -w -t ${session}:${winIdx} monitor-silence 0`);
		execSafe(`tmux set-hook -uw -t ${session}:${winIdx} alert-silence`);
	}

	const windows = getWindows(session);
	const win = windows.find((w) => w.index === winIdx);
	const winName = win?.title ?? `window ${winIdx}`;

	const output = execSafe(`tmux capture-pane -t ${session}:${winIdx} -p -S -30`);
	const trimmedOutput = (output ?? "")
		.split("\n")
		.filter((l) => l.trim())
		.slice(-20)
		.join("\n");

	const code = parseInt(exitCode);
	const status = code === 0 ? "completed successfully" : `exited with code ${code}`;

	pi.sendMessage(
		{
			customType: "tmux-completion",
			content: `tmux window "${winName}" (:${winIdx}) ${status}.\n\n\`\`\`\n${trimmedOutput}\n\`\`\``,
			display: true,
		},
		{
			triggerTurn: true,
			deliverAs: "followUp",
		},
	);
}

function handleSilenceSignal(pi: ExtensionAPI, filepath: string, filename: string): void {
	unlinkSync(filepath);

	const inner = filename.slice("silent.".length);
	const parsed = parseSignalFilename(inner);
	if (!parsed) return;
	const { session, winIdx, id } = parsed;

	const silenceKey = `${session}.${winIdx}.${id}`;
	const state = silenceState.get(silenceKey);
	if (!state) return;

	const windows = getWindows(session);
	const win = windows.find((w) => w.index === winIdx);
	const winName = win?.title ?? `window ${winIdx}`;

	const output = execSafe(`tmux capture-pane -t ${session}:${winIdx} -p -S -30`);
	const trimmedOutput = (output ?? "")
		.split("\n")
		.filter((l) => l.trim())
		.slice(-20)
		.join("\n");

	pi.sendMessage(
		{
			customType: "tmux-silence",
			content: `tmux window "${winName}" (:${winIdx}) has been silent for ${state.current}s — may be waiting for input. Use action "mute" with window ${winIdx} to suppress further silence notifications for this window.\n\n\`\`\`\n${trimmedOutput}\n\`\`\``,
			display: true,
		},
		{
			triggerTurn: true,
			deliverAs: "followUp",
		},
	);

	const next = Math.min(Math.round(state.current * state.factor), state.cap);
	state.current = next;
	execSafe(`tmux set-option -w -t ${session}:${winIdx} monitor-silence ${next}`);
}

export function startWatching(pi: ExtensionAPI): void {
	if (watcher) return;

	const dir = getSignalDir();
	watcher = chokidarWatch(dir, {
		ignoreInitial: true,
		depth: 0,
		ignored: [join(dir, "s"), /\.sh$/],
		awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
	});

	watcher.on("add", (filepath) => {
		try {
			const filename = filepath.split("/").pop();
			if (!filename) return;
			if (filename.startsWith("silent.")) {
				handleSilenceSignal(pi, filepath, filename);
			} else {
				handleCompletionSignal(pi, filepath, filename);
			}
		} catch {
			// Ignore errors from racing deletes
		}
	});
}

export async function stopWatching(): Promise<void> {
	if (watcher) {
		await watcher.close();
		watcher = null;
	}
	silenceState.clear();
	if (SIGNAL_DIR) {
		try {
			const { execSync } = await import("node:child_process");
			execSync(`rm -rf "${SIGNAL_DIR}"`, { timeout: 5000 });
		} catch {
			// best effort
		}
	}
}

export function sendCommandWithSignal(signalDir: string, session: string, windowIndex: number, cmd: string, silence?: SilenceConfig): string {
	const scriptDir = join(signalDir, "s");
	mkdirSync(scriptDir, { recursive: true });
	const id = randomBytes(4).toString("hex");
	const signalFile = join(signalDir, `${session}.${windowIndex}.${id}`);
	const scriptPath = join(scriptDir, `${session}.${windowIndex}.${id}.sh`);
	writeFileSync(
		scriptPath,
		`#!/usr/bin/env bash
cat "$0"
echo '---'
${cmd}
__rc=$?
echo $__rc > "${signalFile}"
`,
		{ mode: 0o755 },
	);
	exec(`tmux send-keys -t ${session}:${windowIndex} "${escapeForTmux(scriptPath)}" C-m`);

	if (silence && silence.timeout > 0) {
		const silenceSignalFile = join(signalDir, `silent.${session}.${windowIndex}.${id}`);
		exec(`tmux set-option -w -t ${session}:${windowIndex} monitor-silence ${silence.timeout}`);
		const hookCmd = `run-shell 'echo 1 > "${escapeForTmux(silenceSignalFile)}"' ; kill-session -C -t ${session}`;
		exec(`tmux set-hook -w -t ${session}:${windowIndex} alert-silence "${escapeForTmux(hookCmd)}"`);
	}

	return id;
}

export function addWindow(signalDir: string, session: string, cwd: string, cmd: string, name: string, silence?: SilenceConfig): { index: number; id: string } {
	const winName = name.slice(0, 30);
	const raw = exec(`tmux new-window -t ${session} -n "${escapeForTmux(winName)}" -c "${cwd}" -P -F "#{window_index}"`);
	const idx = parseInt(raw);
	const id = sendCommandWithSignal(signalDir, session, idx, cmd, silence);
	return { index: idx, id };
}

export function clearSilenceForWindow(session: string, winIdx: number): boolean {
	let muted = false;
	for (const key of silenceState.keys()) {
		const parsed = parseSignalFilename(key);
		if (parsed && parsed.session === session && parsed.winIdx === winIdx) {
			silenceState.delete(key);
			muted = true;
		}
	}
	execSafe(`tmux set-option -w -t ${session}:${winIdx} monitor-silence 0`);
	execSafe(`tmux set-hook -uw -t ${session}:${winIdx} alert-silence`);
	return muted;
}
