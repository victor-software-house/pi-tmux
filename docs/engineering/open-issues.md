# Open Issues — tmux CC mode

## Context

pi-tmux runs commands in a hidden **staging session** (`pi-tmux-HASH-stg`) and displays output in a **view pane** (pane 1 of window 0 in the CC-attached host session). `swap-pane` moves staging panes in and out of the view pane to switch between commands without creating new tabs.

This architecture works at the tmux level: commands execute, output appears in the view pane, and `swap-pane` correctly rotates which staging pane is displayed. However, the metadata and tracking layers built on top of this are broken in several specific ways documented below.

---

## PANE-META: Pane metadata (`@pi_managed`, `@pi_title`) does not survive swap-pane

**What happens:** After running two or more commands, `list`, `peek` by name, `close` by name or index, `focus` by name, and `resume` by name all fail or resolve to wrong panes.

**Why this is a problem:** The model cannot address panes by the names it assigned. It calls `run name: "build"`, then `peek window: "build"` either fails with "No pane" or returns output from a different command. The model has no way to verify what it ran, making the tool unreliable for any workflow that runs more than one command.

**Root cause:** `tmux swap-pane` physically exchanges two panes between positions. When pane A (in staging window 1) is swapped into the view, pane A's ID moves to the host session and the view pane's ID moves to staging window 1. tmux user options (`@pi_managed`, `@pi_title`, `@pi_owner_session`) are properties of the pane ID, not of the window position they occupy. After each swap, the metadata travels with the pane ID to the wrong location.

**Observed fact:** Staging **window names** (set via `tmux rename-window` when the window is created) are stable across any number of `swap-pane` operations. `tmux list-windows -t stg -F '#{window_index}\t#{window_name}'` always reflects the original window names regardless of which pane ID currently occupies each window.

**Fix direction:** Replace all pane-ID-based metadata (`@pi_managed`, `@pi_title`, `@pi_owner_session`, `listManagedPanes`, `resolveManagedPane`) with staging window queries. The staging window index and name are the stable identifiers. Peek, close, list, focus, and resume should all resolve against staging windows, not pane metadata.

**Verification:** After fix, this sequence must work:
1. `run name: "a"` → `run name: "b"` → `run name: "c"`
2. `focus window: "a"` → view shows command A's output
3. `peek window: "b"` → returns command B's output
4. `close window: "c"` → closes only command C
5. `list` → shows A and B with correct names
6. `resume name: "a"` → sends keystrokes to command A's pane

---

## OUTPUT-TRACK: Completion notifications do not tell the model what was omitted

**What happens:** When a command finishes, the notification includes the last 20 non-empty lines. If the command produced 500 lines of output, the model sees 20 and has no indication that 480 lines were dropped.

**Why this is a problem:** The model receives 20 lines and does not know whether 20 lines is the complete output or 2% of it. A test suite that failed on line 30 but passed on lines 480-500 would appear to pass. The model needs two pieces of information to act correctly: how many lines the command produced total, and how many were omitted from the notification.

**Root cause:** `filterPaneOutput()` in `signals.ts` takes the last 20 non-empty lines from the captured output. `capture-pane -S -50` retrieves at most 50 lines of scrollback. The notification message contains only the truncated text with no metadata about the original length or how much was dropped.

**Fix direction:** Before sending a command, record the output position. On completion, compute total lines produced by this specific command. Include in the notification: "X total lines, showing last N" so the model can decide whether to peek. `peek` should support range parameters so the model can read any portion of the command's output.

**Output logging:** Tracking output position via `#{history_size} + #{cursor_y}` is fragile: pane resize causes text reflow that changes both values, `clear` resets cursor_y, and alternate-screen applications (vim, less) corrupt the position. `tmux pipe-pane` writes all pane output to a file as it occurs. This is immune to reflow, survives scrollback overflow, and supports random access by byte offset. Record the file size before `send-keys` and read from that offset after completion to get exactly this command's output.

**Verification:** After fix, run a command that produces 200 lines. The notification must state "200 lines, showing last 20" (or similar). `peek` with a range must return any requested portion.

---

## COMPLETE-BUILTIN: Completion tracker fires prematurely for shell builtins

**What happens:** Commands like `read -r REPLY` block waiting for user input, but the completion tracker immediately marks the command as finished.

**Why this is a problem:** The model reports the command as completed and moves on. The operator sees the command still waiting for input but has no way to signal this back. The `silenceTimeout` parameter, designed specifically for interactive commands that may block, never fires because the completion tracker already declared the command done.

**Root cause:** Shell builtins (`read`, `wait`, `select`, etc.) execute within the shell process itself. The shell does not fork a child process for them. `pane_current_command` (which reports the foreground process name) remains `zsh` or `bash` while the builtin runs. The completion tracker polls `pane_current_command`, sees an idle shell name, and concludes the command has finished. There is no difference in `pane_current_command` between "zsh running `read`" and "zsh at its prompt waiting for the next command."

**Fix direction:** The tracker needs a signal that distinguishes "shell at prompt" from "shell running a builtin." Options: detect the shell prompt string in captured output (requires knowing the prompt format), use shell integration escape sequences (iTerm2/kitty emit markers around prompts), or check whether the shell has any pending input via `pipe-pane` logs. `pgrep -P $pid` does not help because builtins have no child process.

**Verification:** After fix, `run command: "read -r X" silenceTimeout: 10` must NOT fire a completion notification while `read` is blocking. The silence notification must fire after 10 seconds of no output.

---

## FOCUS-LEAK: Focus reporting escape sequences leak into swapped panes

**What happens:** `^[[I` (focus gained) and `^[[O` (focus lost) appear as visible raw text in the view pane when the operator clicks in and out of it.

**Why this is a problem:** The operator sees `^[[I` and `^[[O` characters mixed into command output. If the model peeks at this pane, it receives these sequences as part of the output text and may misinterpret them. The display is corrupted for both human and model consumers.

**Root cause:** The operator's `~/.tmux.conf` sets `focus-events on`, which tells tmux to forward `CSI I` (focus gained) and `CSI O` (focus lost) escape sequences to panes when the terminal window gains or loses focus. Applications that understand these sequences (vim, neovim) consume them silently. But when the foreground process is a simple command like `sleep` or `read`, nothing consumes the sequences and they appear as literal text in the terminal.

**Fix direction:** After each `swap-pane` into the view, send `\e[?1004l` (DECRST 1004 — disable focus event reporting) to the view pane via `tmux send-keys`. This tells the terminal not to send focus sequences to that specific pane. The global `focus-events on` setting remains active for other panes and applications.

**Verification:** After fix, click rapidly in and out of the view pane while a `sleep 999` is running. No `^[[I` or `^[[O` characters should appear.

---

## ATTACH-VERIFY: `attach` does not verify the view pane actually exists

**What happens:** `attach` returns "View pane already visible" or "Already attached" based on an in-memory flag, without checking whether the view pane (pane 1 of window 0 in the host session) still exists in tmux.

**Why this is a problem:** If the operator manually closes the split (e.g. by clicking the close button in iTerm2), or if the view pane's shell exits, `attach` reports success but no split is visible. The model proceeds as if it has a visible terminal — subsequent `run` commands create staging panes and swap them into a view pane that does not exist.

**Fix direction:** Before returning "already visible", run `tmux list-panes -t '=HOST:0' -F '#{pane_index}'` and check that pane index 1 exists in the output. If it does not, reset the `viewPaneId` tracking variable in `terminal-tmux.ts` and create a new split via `split-window`.

**Verification:** After fix: run a command (creates view pane), manually close the split in iTerm2, then call `attach`. It must recreate the split, not report "already visible."
