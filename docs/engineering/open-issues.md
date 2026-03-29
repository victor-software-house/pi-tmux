# Open Issues — tmux CC mode

## Context

pi-tmux runs commands in a hidden **staging session** (`pi-tmux-HASH-stg`) and displays output in a **view pane** (pane 1 of window 0 in the CC-attached host session). `swap-pane` moves staging panes in and out of the view pane to switch between commands without creating new tabs.

This architecture works at the tmux level: commands execute, output is visible, and swap-pane correctly rotates content. However, the metadata and tracking layers above it are broken in several ways that make the tool unreliable for the model and the operator.

---

## 1. Pane metadata (`@pi_managed`, `@pi_title`) does not survive swap-pane

**What happens:** After running two or more commands, `list`, `peek` by name, `close` by name or index, `focus` by name, and `resume` by name all fail or resolve to wrong panes.

**Why this is a problem:** The model cannot reliably address panes by the names it gave them. It runs `name: "build"`, then `peek window: "build"` fails or returns output from a different command. This makes the tool untrustworthy — the model cannot verify its own work.

**Root cause:** `swap-pane` exchanges pane IDs between the staging session and the view pane. tmux user options (`@pi_managed`, `@pi_title`, `@pi_owner_session`) are attached to pane IDs, not to window positions. After each swap, the metadata ends up on the wrong pane in the wrong window.

**Observed:** Staging **window names** (set via `tmux rename-window`) are always correct after any number of swaps. `tmux list-windows -t stg -F '#{window_index}\t#{window_name}'` consistently reflects what was created, regardless of swap history.

**Fix direction:** Replace all pane-ID-based metadata (`@pi_managed`, `@pi_title`, `@pi_owner_session`, `listManagedPanes`, `resolveManagedPane`) with staging window queries. The staging window index and name are the stable identifiers. Peek, close, list, focus, and resume should all resolve against staging windows, not pane metadata.

**Verification:** After fix, this sequence must work:
1. `run name: "a"` → `run name: "b"` → `run name: "c"`
2. `focus window: "a"` → view shows command A's output
3. `peek window: "b"` → returns command B's output
4. `close window: "c"` → closes only command C
5. `list` → shows A and B with correct names
6. `resume name: "a"` → sends keystrokes to command A's pane

---

## 2. Completion notifications do not tell the model what was omitted

**What happens:** When a command finishes, the notification includes the last 20 non-empty lines. If the command produced 500 lines of output, the model sees 20 and has no indication that 480 lines were dropped.

**Why this is a problem:** The model cannot make an informed decision about whether to peek for more context. It might assume a test suite passed when the truncated tail only shows the last few passing tests, while failures scrolled off. The model needs to know: "this command produced N lines, you are seeing the last 20, use peek to read more."

**Root cause:** `filterPaneOutput()` in `signals.ts` silently truncates to 20 lines. `capture-pane -S -50` only grabs 50 lines from scrollback. Neither the capture nor the notification includes any count of what was omitted.

**Fix direction:** Before sending a command, record the output position. On completion, compute total lines produced by this specific command. Include in the notification: "X total lines, showing last N" so the model can decide whether to peek. `peek` should support range parameters so the model can read any portion of the command's output.

**Output logging:** `capture-pane` with `history_size + cursor_y` tracking is fragile (breaks on resize, clear, alternate screen). `tmux pipe-pane` to per-pane log files is more robust: immune to reflow, supports random access via file offsets, and survives scrollback overflow.

**Verification:** After fix, run a command that produces 200 lines. The notification must state "200 lines, showing last 20" (or similar). `peek` with a range must return any requested portion.

---

## 3. Completion tracker fires prematurely for shell builtins

**What happens:** Commands like `read -r REPLY` block waiting for user input, but the completion tracker immediately marks the command as finished.

**Why this is a problem:** The model reports the command is done when the operator hasn't had a chance to interact. Silence timeout notifications, which exist specifically for interactive commands, never fire because the tracker already declared completion.

**Root cause:** `read`, `wait`, and other shell builtins run inside the shell process. `pane_current_command` remains `zsh` (or `bash`), which the tracker interprets as "idle shell = command finished." The tracker cannot distinguish a shell waiting for a builtin from a shell that has returned to its prompt.

**Fix direction:** The tracker needs a secondary signal beyond `pane_current_command`. Options include: checking for child processes via `pgrep -P $pid`, detecting the shell prompt pattern in captured output, or using shell integration escape sequences that mark prompt boundaries. The `pipe-pane` log approach (from issue #2) could also detect the prompt appearing after command output.

**Verification:** After fix, `run command: "read -r X" silenceTimeout: 10` must NOT fire a completion notification while `read` is blocking. The silence notification must fire after 10 seconds of no output.

---

## 4. Focus reporting escape sequences leak into swapped panes

**What happens:** `^[[I` (focus gained) and `^[[O` (focus lost) appear as visible raw text in the view pane when the operator clicks in and out of it.

**Why this is a problem:** The operator sees garbage characters in their command output. The model may see them in peek output and misinterpret them as command output. This degrades trust in the output display.

**Root cause:** The global tmux config has `focus-events on`, which is needed for many terminal applications. tmux sends focus sequences to panes. When a swapped-in pane is running a blocking command (sleep, read, etc.), the process does not consume these sequences, so they render as raw text.

**Fix direction:** After each `swap-pane` into the view, send the "disable focus reporting" sequence (`\e[?1004l`) to the view pane. This suppresses focus sequences for that pane without affecting the global setting. Alternatively, investigate per-pane focus-events control if tmux supports it.

**Verification:** After fix, click rapidly in and out of the view pane while a `sleep 999` is running. No `^[[I` or `^[[O` characters should appear.

---

## 5. `attach` does not verify the view pane actually exists

**What happens:** `attach` returns "View pane already visible" or "Already attached" based on an in-memory flag, without checking whether the view pane (pane 1 of window 0 in the host session) still exists in tmux.

**Why this is a problem:** If the operator manually closes the split, or if the view pane dies for any reason, `attach` reports success but the operator sees nothing. The model believes it has a visible terminal and proceeds accordingly.

**Fix direction:** Before returning "already visible", verify pane 1 exists via `tmux list-panes -t host:0`. If missing, recreate it. Reset the in-memory tracking flag when the pane is confirmed dead.

**Verification:** After fix: run a command (creates view pane), manually close the split in iTerm2, then call `attach`. It must recreate the split, not report "already visible."
