/**
 * tmux extension - manages a tmux session per project (git root).
 *
 * Tool: tmux (run/attach/peek/list/kill)
 * Commands: /tmux (settings), /tmux attach|tab|split|cat|clear|show|kill|help
 *
 * Completion notifications: commands are wrapped so that when they finish,
 * a signal file is written. A fs.watch picks it up and injects a message
 * into the conversation with the exit code and recent output.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type, type Static } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { execSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { watch as chokidarWatch, type FSWatcher } from "chokidar";


const SIGNAL_BASE = "/tmp/pi-tmux";

// ---------------------------------------------------------------------------
// Settings persistence
// ---------------------------------------------------------------------------

type AutoAttachMode = "never" | "session-create" | "always";
type AttachLayout = "split-vertical" | "tab" | "split-horizontal";

interface TmuxSettings {
  autoAttach: AutoAttachMode;
  defaultLayout: AttachLayout;
}

const DEFAULT_SETTINGS: TmuxSettings = {
  autoAttach: "session-create",
  defaultLayout: "split-vertical",
};

const AUTO_ATTACH_VALUES: readonly AutoAttachMode[] = ["never", "session-create", "always"];
const LAYOUT_VALUES: readonly AttachLayout[] = ["split-vertical", "tab", "split-horizontal"];

const SETTINGS_PATH = join(homedir(), ".pi", "agent", ".pi-tmux.json");

function loadSettings(): TmuxSettings {
  try {
    if (!existsSync(SETTINGS_PATH)) return { ...DEFAULT_SETTINGS };
    const raw = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    return {
      autoAttach: AUTO_ATTACH_VALUES.includes(raw?.autoAttach) ? raw.autoAttach : DEFAULT_SETTINGS.autoAttach,
      defaultLayout: LAYOUT_VALUES.includes(raw?.defaultLayout) ? raw.defaultLayout : DEFAULT_SETTINGS.defaultLayout,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings: TmuxSettings): void {
  const dir = join(homedir(), ".pi", "agent");
  mkdirSync(dir, { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
}

let currentSettings = loadSettings();

const TmuxParams = Type.Object({
  action: StringEnum(["run", "attach", "peek", "list", "kill", "mute"] as const),
  command: Type.Optional(
    Type.String({
      description: "Command to run (for 'run' action).",
    })
  ),
  name: Type.Optional(
    Type.String({
      description: "Short descriptive name for the tmux window (for 'run' action). E.g. 'dev-server'.",
    })
  ),
  silenceTimeout: Type.Optional(
    Type.Number({
      description: "Seconds of silence before notifying that the command may be waiting for input (for 'run' action). Omit or 0 to disable. Default 60.",
    })
  ),
  silenceBackoffFactor: Type.Optional(
    Type.Number({
      description: "Multiply silence interval after each notification (for 'run' action). Default 1.5.",
    })
  ),
  silenceBackoffCap: Type.Optional(
    Type.Number({
      description: "Max silence interval in seconds (for 'run' action). Default 300 (5 min).",
    })
  ),
  window: Type.Optional(
    Type.Union([Type.Number(), Type.String()], {
      description: "Window index or 'all' (for 'peek' action). Defaults to 'all'.",
    })
  ),
  mode: Type.Optional(
    Type.String({
      description: "How to open the terminal for 'attach' action: 'split-vertical' (default), 'tab', or 'split-horizontal'.",
    })
  ),
  attach: Type.Optional(
    Type.Boolean({
      description: "For 'run' action: auto-attach a terminal split pane so the user sees output live. Default false. Set to true when the user explicitly asks to see tmux output or asks to 'use tmux'.",
    })
  ),
  cwd: Type.Optional(
    Type.String({
      description: "Working directory for the command (for 'run' action). Defaults to project root (git root or pi's cwd).",
    })
  ),
});

type TmuxInput = Static<typeof TmuxParams>;

function exec(cmd: string): string {
  return execSync(cmd, { encoding: "utf-8", timeout: 10000 }).trim();
}

function execSafe(cmd: string): string | null {
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

/**
 * Get the project root for tmux session scoping.
 * Prefers git root, falls back to the given cwd so tmux works outside git repos.
 */
function getProjectRoot(cwd: string): string {
  return getGitRoot(cwd) ?? cwd;
}

function sessionName(gitRoot: string): string {
  const slug = gitRoot.split("/").pop()!.slice(0, 16).toLowerCase();
  const hash = createHash("md5").update(gitRoot).digest("hex").slice(0, 8);
  return `${slug}-${hash}`;
}

function sessionExists(name: string): boolean {
  return execSafe(`tmux has-session -t ${name} 2>/dev/null && echo yes`) === "yes";
}

function getWindows(name: string): { index: number; title: string; active: boolean }[] {
  const raw = execSafe(
    `tmux list-windows -t ${name} -F "#{window_index}|||#{window_name}|||#{window_active}"`
  );
  if (!raw) return [];
  return raw.split("\n").map((line) => {
    const [index, title, active] = line.split("|||");
    return { index: parseInt(index), title, active: active === "1" };
  });
}

function capturePanes(name: string, window: number | "all"): string {
  const windows = getWindows(name);
  const targets =
    window === "all" ? windows : windows.filter((w) => w.index === window);

  if (targets.length === 0) return "No matching windows.";

  return targets
    .map((w) => {
      const output = execSafe(`tmux capture-pane -t ${name}:${w.index} -p -S -50`);
      return `── window ${w.index}: ${w.title} ──\n${output ?? "(empty)"}`;
    })
    .join("\n\n");
}

const IT2API = "/Applications/iTerm.app/Contents/Resources/utilities/it2api";
const IT2API_INSTALL_HINT = "Enable: iTerm2 > Settings > General > Magic > Enable Python API. Then: uv pip install --system iterm2";

/** Check if it2api is available (iTerm2 installed, python3 + iterm2 package present, API enabled). */
let _it2apiAvailable: boolean | null = null;
function isIt2apiAvailable(): boolean {
  if (_it2apiAvailable === null) {
    _it2apiAvailable = execSafe(`${IT2API} list-sessions 2>/dev/null`) !== null;
  }
  return _it2apiAvailable;
}

/** Get the iTerm2 session ID of the currently focused session via it2api. */
function getActiveiTermSession(): string | null {
  if (!isIt2apiAvailable()) return null;
  const raw = execSafe(`${IT2API} show-focus 2>/dev/null`);
  if (!raw) return null;
  const match = raw.match(/id=([0-9A-F-]{36})/);
  return match?.[1] ?? null;
}

/** Get the iTerm2 window ID of the key (focused) window via it2api. */
function getActiveiTermWindow(): string | null {
  if (!isIt2apiAvailable()) return null;
  const raw = execSafe(`${IT2API} show-focus 2>/dev/null`);
  if (!raw) return null;
  const match = raw.match(/Key window:\s*(pty-[0-9A-F-]+)/);
  return match?.[1] ?? null;
}

/** Track iTerm session IDs created by attach operations, keyed by tmux session name. */
const attachedItermSessions = new Map<string, Set<string>>();

function trackAttachedSession(tmuxSession: string, itermSessionId: string): void {
  let set = attachedItermSessions.get(tmuxSession);
  if (!set) {
    set = new Set();
    attachedItermSessions.set(tmuxSession, set);
  }
  set.add(itermSessionId);
}

function closeAttachedSessions(tmuxSession: string): void {
  const ids = attachedItermSessions.get(tmuxSession);
  if (!ids || !isIt2apiAvailable()) return;
  for (const id of ids) {
    // Ctrl-C to clear any pending input, then exit.
    // exec'd shells will already be dead after tmux kill-session,
    // but this handles edge cases (osascript fallback, stale panes).
    execSafe(`${IT2API} send-text "${id}" "\x03"`);
    execSafe(`${IT2API} send-text "${id}" "exit\n"`);
  }
  attachedItermSessions.delete(tmuxSession);
}

interface AttachOptions {
  /** tmux session name */
  session: string;
  /** Layout mode */
  mode?: AttachLayout;
  /** Specific tmux window index to select before attaching */
  tmuxWindow?: number;
  /** iTerm session ID of the pane running pi (for targeted splits) */
  piSessionId?: string | null;
}

function openTerminalTab(opts: AttachOptions): string {
  const { session, tmuxWindow } = opts;
  const mode = opts.mode ?? currentSettings.defaultLayout;
  const term = process.env.TERM_PROGRAM ?? "";

  // Select the specific window first if requested
  if (tmuxWindow !== undefined) {
    execSafe(`tmux select-window -t ${session}:${tmuxWindow}`);
  }

  const attachCmd = `tmux attach -t ${session}`;

  // Already inside tmux (e.g. VPS via -CC, or local tmux) — use native tmux
  // splits/tabs. With -CC, iTerm2 renders these as native panes automatically.
  if (process.env.TMUX) {
    if (mode === "split-vertical") {
      exec(`tmux split-window -h -t ${session}`);
      return `Opened tmux vertical split in session ${session}.`;
    } else if (mode === "split-horizontal") {
      exec(`tmux split-window -v -t ${session}`);
      return `Opened tmux horizontal split in session ${session}.`;
    } else {
      exec(`tmux new-window -t ${session}`);
      return `Opened tmux tab in session ${session}.`;
    }
  }

  switch (term) {
    case "iTerm.app": {
      const isSplit = mode === "split-vertical" || mode === "split-horizontal";
      const label = isSplit ? `${mode.replace("split-", "")} split` : "tab";

      // Use the pi session ID if provided, otherwise fall back to active session.
      // This ensures splits open next to the pi pane, not wherever the user last clicked.
      const targetSession = opts.piSessionId ?? getActiveiTermSession();
      if (targetSession) {
        if (isSplit) {
          const flag = mode === "split-vertical" ? " --vertical" : "";
          const result = execSafe(`${IT2API} split-pane${flag} "${targetSession}"`);
          const newId = result?.match(/id=([0-9A-F-]{36})/)?.[1];
          if (newId) {
            trackAttachedSession(session, newId);
            execSafe(`${IT2API} send-text "${newId}" "exec ${escapeForTmux(attachCmd)}\n"`);
            return `Opened iTerm2 ${label} attached to ${session}.`;
          }
        } else {
          const windowId = getActiveiTermWindow();
          const windowFlag = windowId ? ` --window "${windowId}"` : "";
          const result = execSafe(`${IT2API} create-tab${windowFlag}`);
          const newId = result?.match(/id=([0-9A-F-]{36})/)?.[1];
          if (newId) {
            trackAttachedSession(session, newId);
            execSafe(`${IT2API} send-text "${newId}" "exec tmux -CC attach -t ${escapeForTmux(session)}\n"`);
            return `Opened iTerm2 tab attached to ${session}.`;
          }
        }
      }

      // Fallback: osascript
      const warning = `\x1b[33m[pi-tmux] iTerm2 Python API not available. Using legacy attach (no native integration).\n${IT2API_INSTALL_HINT}\x1b[0m`;
      if (isSplit) {
        const direction = mode === "split-vertical" ? "vertically" : "horizontally";
        exec(`osascript -e '
          tell application "iTerm2"
            tell current session of current window
              set newSession to (split ${direction} with default profile)
              tell newSession
                write text "exec ${escapeForTmux(attachCmd)}"
              end tell
            end tell
          end tell'`);
      } else {
        exec(`osascript -e '
          tell application "iTerm2"
            tell current window
              set newTab to (create tab with default profile)
              tell current session of newTab
                write text "exec ${escapeForTmux(attachCmd)}"
              end tell
            end tell
          end tell'`);
      }
      return `${warning}\nOpened iTerm2 ${label} attached to ${session}.`;
    }

    case "Apple_Terminal":
      exec(`osascript -e '
        tell application "Terminal"
          activate
          do script "${escapeForTmux(attachCmd)}"
        end tell'`);
      return `Opened Terminal.app window attached to ${session}.`;

    case "kitty":
      exec(`kitty @ launch --type=tab ${attachCmd}`);
      return `Opened kitty tab attached to ${session}.`;

    case "ghostty":
      exec(`ghostty -e ${attachCmd} &`);
      return `Opened ghostty window attached to ${session}.`;

    case "WezTerm":
      exec(`wezterm cli spawn -- ${attachCmd}`);
      return `Opened WezTerm tab attached to ${session}.`;

    default:
      return `No supported terminal detected. Run manually:\n  ${attachCmd}`;
  }
}

function attachToSession(cwd: string, opts?: { mode?: AttachLayout; tmuxWindow?: number; piSessionId?: string | null }): string {
  const projectRoot = getProjectRoot(cwd);
  const session = sessionName(projectRoot);
  if (!sessionExists(session)) return `No tmux session for this project.`;

  try {
    return openTerminalTab({
      session,
      mode: opts?.mode,
      tmuxWindow: opts?.tmuxWindow,
      piSessionId: opts?.piSessionId,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return `Failed: ${msg}\nRun manually:\n  tmux attach -t ${session}`;
  }
}

interface SilenceConfig {
  timeout: number;
  factor: number;
  cap: number;
}

/**
 * Write a per-window script that echoes itself before executing.
 * cat "$0" prints the full script (including heredocs etc. that set -x misses),
 * then a separator, then the actual command runs.
 *
 * If silence config is provided, sets up monitor-silence and an alert-silence
 * hook on the window to write a signal file when the command goes quiet.
 */
function sendCommandWithSignal(signalDir: string, session: string, windowIndex: number, cmd: string, silence?: SilenceConfig): string {
  const scriptDir = join(signalDir, "s");
  mkdirSync(scriptDir, { recursive: true });
  const id = randomBytes(4).toString("hex");
  const signalFile = join(signalDir, `${session}.${windowIndex}.${id}`);
  const scriptPath = join(scriptDir, `${session}.${windowIndex}.${id}.sh`);
  writeFileSync(scriptPath, `#!/usr/bin/env bash
cat "$0"
echo '---'
${cmd}
__rc=$?
echo $__rc > "${signalFile}"
`, { mode: 0o755 });
  exec(`tmux send-keys -t ${session}:${windowIndex} "${escapeForTmux(scriptPath)}" C-m`);

  if (silence && silence.timeout > 0) {
    const silenceSignalFile = join(signalDir, `silent.${session}.${windowIndex}.${id}`);
    exec(`tmux set-option -w -t ${session}:${windowIndex} monitor-silence ${silence.timeout}`);
    const hookCmd = `run-shell 'echo 1 > "${escapeForTmux(silenceSignalFile)}"' ; kill-session -C -t ${session}`;
    exec(`tmux set-hook -w -t ${session}:${windowIndex} alert-silence "${escapeForTmux(hookCmd)}"`);
  }

  return id;
}

function addWindow(signalDir: string, session: string, cwd: string, cmd: string, name?: string, silence?: SilenceConfig): { index: number; id: string } {
  const winName = (name ?? cmd.split(/[|;&\s]/)[0].split("/").pop() ?? "shell").slice(0, 30);
  const raw = exec(
    `tmux new-window -t ${session} -n "${escapeForTmux(winName)}" -c "${cwd}" -P -F "#{window_index}"`
  );
  const idx = parseInt(raw);
  const id = sendCommandWithSignal(signalDir, session, idx, cmd, silence);
  return { index: idx, id };
}

function escapeForTmux(s: string): string {
  return s.replace(/"/g, '\\"');
}

export default function (pi: ExtensionAPI) {
  // Capture the iTerm session ID where pi is running so attach targets the right pane.
  let piSessionId: string | null = null;
  function capturePiSession(): void {
    if (process.env.TERM_PROGRAM === "iTerm.app") {
      piSessionId = getActiveiTermSession();
    }
  }

  // Each pi instance gets its own signal directory to avoid cross-talk.
  // Resolved lazily on first use (needs session_start to have fired).
  let SIGNAL_DIR: string | null = null;

  function getSignalDir(): string {
    if (!SIGNAL_DIR) {
      // Shouldn't happen — run is called after session_start
      SIGNAL_DIR = join(SIGNAL_BASE, randomBytes(8).toString("hex"));
      mkdirSync(SIGNAL_DIR, { recursive: true });
    }
    return SIGNAL_DIR;
  }

  pi.on("session_start", async (_event, ctx) => {
    capturePiSession();
    currentSettings = loadSettings();

    const sessionFile = ctx.sessionManager.getSessionFile();
    const id = sessionFile
      ? createHash("md5").update(sessionFile).digest("hex").slice(0, 16)
      : randomBytes(8).toString("hex");
    SIGNAL_DIR = join(SIGNAL_BASE, id);
    mkdirSync(SIGNAL_DIR, { recursive: true });
  });

  // Per-window silence backoff state, keyed by "session.windowIndex.id"
  const silenceState = new Map<string, { current: number; factor: number; cap: number }>();

  // Track watcher for cleanup
  let watcher: FSWatcher | null = null;

  /** Parse "session.windowIndex.id" from a signal filename. */
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

  function handleCompletionSignal(filepath: string, filename: string) {
    const exitCode = readFileSync(filepath, "utf-8").trim();
    unlinkSync(filepath);

    const parsed = parseSignalFilename(filename);
    if (!parsed) return;
    const { session, winIdx, id } = parsed;

    // Disable silence monitoring for this window
    const silenceKey = `${session}.${winIdx}.${id}`;
    if (silenceState.has(silenceKey)) {
      silenceState.delete(silenceKey);
      execSafe(`tmux set-option -w -t ${session}:${winIdx} monitor-silence 0`);
      execSafe(`tmux set-hook -uw -t ${session}:${winIdx} alert-silence`);
    }

    // Get window name
    const windows = getWindows(session);
    const win = windows.find((w) => w.index === winIdx);
    const winName = win?.title ?? `window ${winIdx}`;

    // Capture recent output
    const output = execSafe(`tmux capture-pane -t ${session}:${winIdx} -p -S -30`);
    const trimmedOutput = (output ?? "").split("\n").filter(l => l.trim()).slice(-20).join("\n");

    const code = parseInt(exitCode);
    const status = code === 0 ? "completed successfully" : `exited with code ${code}`;

    pi.sendMessage({
      customType: "tmux-completion",
      content: `tmux window "${winName}" (:${winIdx}) ${status}.\n\n\`\`\`\n${trimmedOutput}\n\`\`\``,
      display: true,
    }, {
      triggerTurn: true,
      deliverAs: "followUp",
    });
  }

  function handleSilenceSignal(filepath: string, filename: string) {
    unlinkSync(filepath);

    // Strip "silent." prefix and parse
    const inner = filename.slice("silent.".length);
    const parsed = parseSignalFilename(inner);
    if (!parsed) return;
    const { session, winIdx, id } = parsed;

    const silenceKey = `${session}.${winIdx}.${id}`;
    const state = silenceState.get(silenceKey);
    if (!state) return; // No silence tracking (or already completed)

    // Get window name
    const windows = getWindows(session);
    const win = windows.find((w) => w.index === winIdx);
    const winName = win?.title ?? `window ${winIdx}`;

    // Capture recent output
    const output = execSafe(`tmux capture-pane -t ${session}:${winIdx} -p -S -30`);
    const trimmedOutput = (output ?? "").split("\n").filter(l => l.trim()).slice(-20).join("\n");

    pi.sendMessage({
      customType: "tmux-silence",
      content: `tmux window "${winName}" (:${winIdx}) has been silent for ${state.current}s — may be waiting for input. Use action "mute" with window ${winIdx} to suppress further silence notifications for this window.\n\n\`\`\`\n${trimmedOutput}\n\`\`\``,
      display: true,
    }, {
      triggerTurn: true,
      deliverAs: "followUp",
    });

    // Backoff: increase monitor-silence interval
    const next = Math.min(Math.round(state.current * state.factor), state.cap);
    state.current = next;
    execSafe(`tmux set-option -w -t ${session}:${winIdx} monitor-silence ${next}`);
  }

  function startWatching() {
    if (watcher) return;

    const dir = getSignalDir();
    watcher = chokidarWatch(dir, {
      ignoreInitial: true,
      depth: 0,
      // Ignore script subdirectory and .sh files
      ignored: [join(dir, "s"), /\.sh$/],
      // Small stabilization delay for atomic writes
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    });

    watcher.on("add", (filepath) => {
      try {
        const filename = filepath.split("/").pop()!;
        if (filename.startsWith("silent.")) {
          handleSilenceSignal(filepath, filename);
        } else {
          handleCompletionSignal(filepath, filename);
        }
      } catch {
        // Ignore errors from racing deletes etc.
      }
    });
  }

  // Clean up on shutdown
  pi.on("session_shutdown", async () => {
    if (watcher) {
      await watcher.close();
      watcher = null;
    }
    silenceState.clear();
    // Remove this instance's signal directory
    if (SIGNAL_DIR) {
      try { execSync(`rm -rf "${SIGNAL_DIR}"`, { timeout: 5000 }); } catch {}
    }
  });

  // /tmux — unified command family
  const TMUX_SUBCOMMANDS = ["attach", "tab", "split", "hsplit", "show", "cat", "clear", "kill", "help"];

  pi.registerCommand("tmux", {
    description: "Manage tmux session. /tmux opens settings. /tmux attach|tab|split|hsplit|show|cat|clear|kill|help",
    getArgumentCompletions(prefix) {
      const lp = (prefix ?? "").toLowerCase();
      const matches = TMUX_SUBCOMMANDS.filter((s) => s.startsWith(lp));
      return matches.length > 0 ? matches.map((s) => ({ label: s, value: s })) : null;
    },
    handler: async (args, ctx) => {
      const sub = (args ?? "").trim().toLowerCase();
      const projectRoot = getProjectRoot(ctx.cwd);
      const session = sessionName(projectRoot);

      // --- Settings panel (no args) ---
      if (!sub) {
        if (!ctx.hasUI) {
          ctx.ui.notify(`auto-attach: ${currentSettings.autoAttach}\ndefault-layout: ${currentSettings.defaultLayout}`, "info");
          return;
        }

        const { getSettingsListTheme } = await import("@mariozechner/pi-coding-agent");
        const { Container, SettingsList, Text: TuiText } = await import("@mariozechner/pi-tui");

        await ctx.ui.custom((_tui, theme, _kb, done) => {
          const items = [
            {
              id: "autoAttach",
              label: "Auto-attach on run",
              description: "never: ignore attach requests | session-create: attach on first run only | always: attach every time",
              currentValue: currentSettings.autoAttach,
              values: [...AUTO_ATTACH_VALUES],
            },
            {
              id: "defaultLayout",
              label: "Default attach layout",
              description: "How new terminal panes open when attaching",
              currentValue: currentSettings.defaultLayout,
              values: [...LAYOUT_VALUES],
            },
          ];

          const container = new Container();
          container.addChild(new TuiText(theme.fg("accent", theme.bold("tmux settings")), 1, 1));

          const settingsList = new SettingsList(
            items,
            6,
            getSettingsListTheme(),
            (id, newValue) => {
              if (id === "autoAttach" && AUTO_ATTACH_VALUES.includes(newValue as AutoAttachMode)) {
                currentSettings.autoAttach = newValue as AutoAttachMode;
              } else if (id === "defaultLayout" && LAYOUT_VALUES.includes(newValue as AttachLayout)) {
                currentSettings.defaultLayout = newValue as AttachLayout;
              }
              saveSettings(currentSettings);
            },
            () => done(undefined),
          );

          container.addChild(settingsList);
          return {
            render: (width: number) => container.render(width),
            invalidate: () => container.invalidate(),
            handleInput: (data: string) => { settingsList.handleInput?.(data); },
          };
        });
        return;
      }

      // --- Attach shortcuts ---
      const attachModes: Record<string, AttachLayout> = {
        attach: currentSettings.defaultLayout,
        tab: "tab",
        split: "split-vertical",
        hsplit: "split-horizontal",
      };
      if (sub in attachModes) {
        const msg = attachToSession(ctx.cwd, { mode: attachModes[sub], piSessionId });
        ctx.ui.notify(msg, msg.startsWith("Failed") || msg.startsWith("No") ? "error" : "info");
        return;
      }

      // --- Show ---
      if (sub === "show") {
        if (!sessionExists(session)) {
          ctx.ui.notify("No tmux session for this project.", "info");
          return;
        }
        const windows = getWindows(session);
        const lines = windows.map((w) => `  :${w.index}  ${w.title}${w.active ? "  (active)" : ""}`);
        ctx.ui.notify(`Session ${session} — ${windows.length} window(s)\n${lines.join("\n")}`, "info");
        return;
      }

      // --- Cat ---
      if (sub === "cat") {
        if (!sessionExists(session)) { ctx.ui.notify("No tmux session for this project.", "error"); return; }
        const windows = getWindows(session);
        if (windows.length === 0) { ctx.ui.notify("No windows in session.", "error"); return; }

        const options = [
          "all windows",
          ...windows.map((w) => `:${w.index}  ${w.title}${w.active ? "  (active)" : ""}`),
        ];

        const choice = await ctx.ui.select("Capture output from:", options);
        if (choice === undefined || choice === null) return;

        let target: number | "all";
        if (String(choice) === "0" || choice === "all windows") {
          target = "all";
        } else {
          const idx = typeof choice === "number" ? choice - 1 : options.indexOf(String(choice)) - 1;
          const win = windows[idx];
          if (!win) { ctx.ui.notify("Invalid window selection.", "error"); return; }
          target = win.index;
        }
        const output = capturePanes(session, target);

        pi.sendUserMessage(`Here is the tmux output:\n\n\`\`\`\n${output}\n\`\`\``, {
          deliverAs: "followUp",
        });
        return;
      }

      // --- Clear ---
      if (sub === "clear") {
        if (!sessionExists(session)) { ctx.ui.notify("No tmux session for this project.", "error"); return; }

        const shells = new Set(["bash", "zsh", "sh", "fish", "dash"]);
        const raw = execSafe(
          `tmux list-windows -t ${session} -F "#{window_index}|||#{window_name}|||#{pane_current_command}|||#{pane_pid}"`
        );
        if (!raw) { ctx.ui.notify("No windows in session.", "error"); return; }

        const idle = raw.split("\n")
          .map((line) => {
            const [idx, _name, cmd, pid] = line.split("|||");
            return { index: parseInt(idx ?? "0"), cmd: cmd ?? "", pid: pid ?? "" };
          })
          .filter((w) => {
            if (!shells.has(w.cmd)) return false;
            const children = execSafe(`pgrep -P ${w.pid}`);
            return !children;
          });

        if (idle.length === 0) {
          ctx.ui.notify("No idle windows to clear.", "info");
          return;
        }

        for (const w of idle) {
          execSafe(`tmux kill-window -t ${session}:${w.index}`);
        }

        if (!sessionExists(session)) {
          ctx.ui.notify(`Cleared ${idle.length} idle window(s) — session closed.`, "info");
        } else {
          ctx.ui.notify(`Cleared ${idle.length} idle window(s).`, "info");
        }
        return;
      }

      // --- Kill ---
      if (sub === "kill") {
        if (!sessionExists(session)) { ctx.ui.notify("No tmux session to kill.", "info"); return; }
        closeAttachedSessions(session);
        exec(`tmux kill-session -t ${session}`);
        ctx.ui.notify(`Killed session ${session}.`, "info");
        return;
      }

      // --- Help ---
      if (sub === "help") {
        ctx.ui.notify([
          "/tmux              Settings panel",
          "/tmux attach       Attach (default layout)",
          "/tmux tab          Attach as tab",
          "/tmux split        Attach as vertical split",
          "/tmux hsplit        Attach as horizontal split",
          "/tmux show         Session info",
          "/tmux cat          Capture output into conversation",
          "/tmux clear        Kill idle windows",
          "/tmux kill         Kill session",
          "/tmux help         This help",
        ].join("\n"), "info");
        return;
      }

      ctx.ui.notify(`Unknown: /tmux ${sub}. Try /tmux help`, "warning");
    },
  });

  // tmux tool — for the agent
  pi.registerTool({
    name: "tmux",
    label: "tmux",
    description: `Manage a tmux session for the current project (one session per git root or working directory).

WHEN TO USE: Prefer this over bash for long-running or background commands: dev servers, file watchers, build processes, test suites, anything that runs continuously or takes more than a few seconds. Use bash for quick one-shot commands that complete immediately (ls, cat, grep, git status, etc.).

Actions:
- run: Run a command in a new tmux window. If the session already exists, a new window is added to it. When the command finishes, the agent is automatically notified with the exit code and recent output. Use silenceTimeout to get notified when the command may be waiting for input. Use 'attach: true' to auto-open a split pane so the user sees output live (controlled by user's auto-attach setting).
- attach: Open a terminal view attached to the session (for the user to interact with). Supports iTerm2, Terminal.app, kitty, ghostty, WezTerm, and tmux nesting. Use 'mode' param to control layout: 'split-vertical' (default), 'tab', or 'split-horizontal'. Splits open next to the pi pane.
- peek: Capture recent output from tmux windows. Use window param to target a specific window, or omit for all. Use this to check on running processes.
- list: List all windows in the session.
- kill: Kill the entire session.
- mute: Suppress silence notifications for a window (requires window index). Use when a command is expected to have long silence periods, not waiting for input.

The user can also type /tmux to open settings, /tmux attach to open a terminal split, /tmux tab to open in a new tab, /tmux split-horizontal to split horizontally, or /tmux cat to select a window and bring its output into the conversation.`,
    promptSnippet: "Manage a tmux session for the current project (one session per git root or working directory). Prefer this over bash for long-running or background commands.",
    promptGuidelines: [
      "Prefer tmux over bash for long-running or background commands: dev servers, file watchers, build processes, test suites, anything that runs continuously or takes more than a few seconds. Use bash for quick one-shot commands that complete immediately (ls, cat, grep, git status, etc.).",
      "After using tmux 'run', you do not need to poll or wait to find out when a command finishes. The session will automatically notify you with the exit code and recent output when the command completes — just move on to other work. You can still peek at any time to check intermediate output from a running process.",
      "When the user explicitly asks to 'use tmux', 'show me in tmux', or wants to see commands running, use 'attach: true' on the run call to auto-open a visible split pane. Also call 'attach' after run when the user wants to interact with the terminal.",
      "For commands that might prompt for input (installers, interactive tools, confirmations), use silenceTimeout to get notified when the command goes quiet. Defaults: 60s initial, 1.5x backoff factor, 5min cap.",
      "NEVER kill tmux sessions unnecessarily — preserve history for later inspection via 'peek'. Only kill when explicitly asked.",
      "Prefer sending commands to an existing window with tmux send-keys instead of creating new windows for every command. Avoid window proliferation.",
    ],
    parameters: TmuxParams,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const projectRoot = getProjectRoot(ctx.cwd);
      const session = sessionName(projectRoot);

      switch (params.action) {
        case "run": {
          if (!params.command) {
            return {
              content: [{ type: "text", text: "Error: 'command' required for run action." }],
    
              details: {},
            };
          }

          // Start watching for completions
          startWatching();

          const signalDir = getSignalDir();
          const exists = sessionExists(session);
          const timeout = params.silenceTimeout ?? 0;
          const silence: SilenceConfig | undefined = timeout > 0
            ? { timeout, factor: params.silenceBackoffFactor ?? 1.5, cap: params.silenceBackoffCap ?? 300 }
            : undefined;
          const windowCwd = params.cwd ?? projectRoot;
          let windowIndex: number;
          let windowId: string;

          if (!exists) {
            const winName = (params.name ?? params.command.split(/[|;&\s]/)[0].split("/").pop() ?? "shell").slice(0, 30);
            exec(`tmux new-session -d -s ${session} -n "${escapeForTmux(winName)}" -c "${windowCwd}"`);
            // Enable silence alerts for all windows regardless of which is current
            exec(`tmux set-option -t ${session} silence-action any`);
            windowId = sendCommandWithSignal(signalDir, session, 0, params.command, silence);
            windowIndex = 0;
          } else {
            // Ensure silence-action is set even on pre-existing sessions
            if (silence) {
              execSafe(`tmux set-option -t ${session} silence-action any`);
            }
            const result = addWindow(signalDir, session, windowCwd, params.command, params.name, silence);
            windowIndex = result.index;
            windowId = result.id;
          }

          // Register silence backoff state
          if (silence) {
            silenceState.set(`${session}.${windowIndex}.${windowId}`, {
              current: silence.timeout,
              factor: silence.factor,
              cap: silence.cap,
            });
          }

          // Auto-attach if requested — gated by user setting
          let attachMsg = "";
          if (params.attach) {
            const shouldAttach =
              currentSettings.autoAttach === "always" ||
              (currentSettings.autoAttach === "session-create" && !exists);
            if (shouldAttach) {
              const mode = (params.mode as AttachLayout | undefined) ?? currentSettings.defaultLayout;
              try {
                attachMsg = "\n" + attachToSession(ctx.cwd, { mode, tmuxWindow: windowIndex, piSessionId });
              } catch {
                attachMsg = "\n(auto-attach failed — use /tmux attach)";
              }
            }
          }

          const label = params.name ? `${params.name}: ` : "";
          return {
            content: [
              {
                type: "text",
                text: `${exists ? "Added to" : "Created"} session ${session}\n  :${windowIndex}  ${label}${params.command}${attachMsg}`,
              },
            ],
            details: { session, existed: exists, windowIndex },
          };
        }

        case "attach": {
          if (!sessionExists(session)) {
            return {
              content: [{ type: "text", text: `No session '${session}' to attach to.` }],
    
              details: {},
            };
          }

          const mode = (params.mode as AttachLayout | undefined) ?? currentSettings.defaultLayout;
          const msg = attachToSession(ctx.cwd, { mode, piSessionId });
          return {
            content: [{ type: "text", text: msg }],
            details: {},
          };
        }

        case "peek": {
          if (!sessionExists(session)) {
            return {
              content: [{ type: "text", text: `No session '${session}'.` }],
    
              details: {},
            };
          }

          const win =
            params.window === undefined || params.window === "all"
              ? "all" as const
              : typeof params.window === "number"
                ? params.window
                : parseInt(params.window);

          const output = capturePanes(
            session,
            typeof win === "string" ? win : isNaN(win as number) ? "all" : win
          );
          return {
            content: [{ type: "text", text: output }],
            details: { session },
          };
        }

        case "list": {
          if (!sessionExists(session)) {
            return {
              content: [{ type: "text", text: `No session '${session}'.` }],
    
              details: {},
            };
          }

          const windows = getWindows(session);
          const lines = windows.map(
            (w) => `  :${w.index}  ${w.title}${w.active ? "  (active)" : ""}`
          );
          return {
            content: [
              {
                type: "text",
                text: `Session ${session} — ${windows.length} window(s)\n${lines.join("\n")}`,
              },
            ],
            details: { session, windows },
          };
        }

        case "kill": {
          if (!sessionExists(session)) {
            return {
              content: [{ type: "text", text: `No session '${session}' to kill.` }],
              details: {},
            };
          }

          closeAttachedSessions(session);
          exec(`tmux kill-session -t ${session}`);
          return {
            content: [{ type: "text", text: `Killed session ${session}.` }],
            details: {},
          };
        }

        case "mute": {
          const win = params.window;
          if (win === undefined || win === "all") {
            return {
              content: [{ type: "text", text: "Error: 'window' (index) required for mute action." }],
    
              details: {},
            };
          }

          const winIdx = typeof win === "number" ? win : parseInt(win);
          if (isNaN(winIdx)) {
            return {
              content: [{ type: "text", text: `Error: invalid window index '${win}'.` }],
    
              details: {},
            };
          }

          // Remove silence state for this window
          let muted = false;
          for (const key of silenceState.keys()) {
            // Keys are "session.windowIndex.id"
            const parsed = parseSignalFilename(key);
            if (parsed && parsed.session === session && parsed.winIdx === winIdx) {
              silenceState.delete(key);
              muted = true;
            }
          }

          // Disable tmux silence monitoring
          execSafe(`tmux set-option -w -t ${session}:${winIdx} monitor-silence 0`);
          execSafe(`tmux set-hook -uw -t ${session}:${winIdx} alert-silence`);

          const windows = getWindows(session);
          const w = windows.find((w) => w.index === winIdx);
          const winName = w?.title ?? `window ${winIdx}`;

          return {
            content: [{ type: "text", text: `Muted silence notifications for "${winName}" (:${winIdx}).` }],
            details: {},
          };
        }

        default:
          return {
            content: [{ type: "text", text: `Unknown action: ${params.action}` }],
  
            details: {},
          };
      }
    },

    renderCall(args, theme) {
      const action = args.action ?? "tmux";
      let text = theme.fg("toolTitle", theme.bold("tmux "));
      text += theme.fg("accent", action);

      if (action === "run" && args.command) {
        const label = args.name ? theme.fg("text", args.name + ": ") : "";
        text += "\n  " + label + theme.fg("muted", args.command);
      } else if (action === "attach" && args.mode && args.mode !== "split-vertical") {
        text += theme.fg("muted", ` (${args.mode})`);
      } else if (action === "peek" && args.window !== undefined) {
        text += theme.fg("muted", ` :${args.window}`);
      }

      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const content = result.content?.[0];
      const raw = content?.type === "text" ? content.text : "";

      if (raw.startsWith("Error:") || raw.startsWith("Failed")) {
        return new Text(theme.fg("error", raw), 0, 0);
      }

      // First line is the summary, rest is detail
      const lines = raw.split("\n");
      const summary = lines[0] ?? "";
      const detail = lines.slice(1).join("\n");

      let text = theme.fg("success", "✓ ") + summary;
      if (expanded && detail) {
        text += "\n" + theme.fg("dim", detail);
      }

      return new Text(text, 0, 0);
    },
  });

  // Custom renderer for completion notifications
  pi.registerMessageRenderer("tmux-completion", (message, { expanded }, theme) => {
    const lines = (message.content as string).split("\n");
    const summary = lines[0] ?? "";
    const detail = lines.slice(1).join("\n");

    const icon = summary.includes("successfully") ? theme.fg("success", "✓") : theme.fg("error", "✗");
    let text = `${icon} ${theme.fg("toolTitle", "tmux")} ${summary}`;
    if (expanded && detail) {
      text += "\n" + theme.fg("dim", detail);
    }

    return new Text(text, 0, 0);
  });

  // Custom renderer for silence notifications
  pi.registerMessageRenderer("tmux-silence", (message, { expanded }, theme) => {
    const lines = (message.content as string).split("\n");
    const summary = lines[0] ?? "";
    const detail = lines.slice(1).join("\n");

    let text = `${theme.fg("warning", "⏸")} ${theme.fg("toolTitle", "tmux")} ${summary}`;
    if (expanded && detail) {
      text += "\n" + theme.fg("dim", detail);
    }

    return new Text(text, 0, 0);
  });
}
