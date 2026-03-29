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

---

## SWAP-SHUFFLE: Sequential auto-focus swaps displace pane contents into wrong staging slots

**What happens:** After `run name: a`, `run name: b`, `run name: c` with `autoFocus: always`, staging window `:1` (named `a`) contains `VERIFY-C` content, `:2` (named `b`) contains `VERIFY-A`, and `:3` (named `c`) contains `VERIFY-B`. The names are correct but the pane contents are rotated.

**Why this is a problem:** `peek window: b` returns the content of whichever pane is currently in staging slot `:2`, which is `VERIFY-A` — not `VERIFY-B`. The model sees the wrong output for the command it asked about. Focus, resume, and close all route to the correct staging window by name, but the pane occupying that window is not the one the name implies.

**Root cause:** Each `run` with auto-focus calls `swapViewPane(host, staging, newIdx)`. This exchanges the current view pane with the pane in `staging:newIdx`. The previous view pane (from the last `run`) goes into `staging:newIdx`, not back to its original staging slot. After three runs:
1. run `a` -> swap view with staging `:1` -> view has `a`-pane, staging `:1` has old view shell
2. run `b` -> swap view with staging `:2` -> view has `b`-pane, staging `:2` has `a`-pane
3. run `c` -> swap view with staging `:3` -> view has `c`-pane, staging `:3` has `b`-pane

Result: staging `:1` has old shell, `:2` has `a`-pane, `:3` has `b`-pane, view has `c`-pane.

**Fix direction:** Eliminate position-based identity entirely. Use a pane label (`@pi_name`) as the sole identity for each command pane. `swap-pane` accepts pane IDs directly (`swap-pane -d -s HOST:W.1 -t %PANE_ID`), so tmux resolves the location — the caller does not need to know which staging window the pane is in.

With this approach:
1. When creating a staging pane, set `@pi_name` on it: `tmux set-option -p -t %PANE @pi_name "build"`
2. To list: scan all panes in the staging session (`list-panes -s`) plus the view pane, read `@pi_name` from each
3. To show a pane: find it by `@pi_name`, swap it into the view by pane ID — single swap, one call
4. The displaced pane goes wherever the new pane came from — does not matter, because identity is the label, not the position

This eliminates:
- `@pi_staging_index` (return-address tracking)
- two-swap sequence (return + fetch)
- any dependency on staging window names matching pane contents
- any position-based invariant that can get out of sync

The current implementation uses `@pi_staging_index` + two-swap as an interim solution. Replace it with `@pi_name` + single pane-ID swap.

**Verification:** After fix, `run a`, `run b`, `run c`, then `peek window: a` must return `VERIFY-A`, `peek window: b` must return `VERIFY-B`, `peek window: c` must return `VERIFY-C`.

---

## HOST-PLUMBING: hostWindowIndex threading is fragile and error-prone

**What happens:** Every action call site in `index.ts` and `command.ts` must manually pass `hostSession` and `hostWindowIndex` as positional arguments. Missing one argument silently falls back to the default (`0`), which targets the wrong tmux window. This has caused multiple rounds of fixes where some call sites were updated and others were missed.

**Why this is a problem:** The pattern of threading optional positional parameters through 6+ layers of function calls is inherently fragile. Adding a new parameter requires touching every call site, and TypeScript does not flag a missing optional argument. Each missed call site silently produces wrong behavior that only manifests during live tmux CC testing.

**Root cause:** The host identity (session name + window index) is resolved once in `state.ts` but then threaded as individual arguments through `index.ts` -> `actions.ts` -> `session.ts` -> `terminal-tmux.ts`. Every function signature grew `hostSession?: string, hostWindowIndex = 0` independently, with no compile-time enforcement that all parameters are provided together.

**Fix direction:** Replace the positional argument threading with a single `HostTarget` object:
```typescript
interface HostTarget {
  session: string;
  windowIndex: number;
}
```
Pass this object through all tmux-mode actions, session helpers, and terminal functions. A single required parameter is harder to forget than two optional positional ones. This should be done during `LEGACY-GATE` phases 2-3 when the legacy branches are removed and the action signatures are simplified.

**Verification:** After fix, `grep -r 'hostSession.*hostWindowIndex' extensions/` should return zero matches — all call sites should use the `HostTarget` object instead.

---

## HOST-MISMATCH: tmux view pane exists in a different iTerm2 tmux window than the visible Pi tab

**What happens:** A `run` call succeeds and tmux shows a live view pane in the detected host session, but the operator sees no new split in the currently active Pi tab.

**Observed during verification:**
- tmux reported host session `13` with pane `1` running the staged command
- `tmux list-panes -t =13:0` showed the split exists
- `it2api show-focus` showed the active iTerm2 tab was `Session "π - pi-tmux (pi)"`
- `it2api show-hierarchy` showed the active iTerm2 window had three normal Pi tabs and no visible split
- `it2api list-tmux-connections` showed the tmux integration owner was a buried session `Default (tmux)`

**Why this is a problem:** The tmux tool reports success and the model believes the operator can see the command output, but the output is rendered in a different iTerm2 tmux integration context than the one the operator is actually looking at. This breaks the core requirement that the operator must see what the model does.

**Root cause confirmed by manual tmux commands:** The extension targets the correct tmux host session, but the wrong tmux **window** within that session. Pi itself was running in session `13`, window `2`, pane `%58`, while the extension created and swapped the view pane in session `13`, window `0`. A manual `split-window -h -t =13:2` immediately produced a visible split in Pi's tab. A manual `swap-pane` then proved that the command output became visible only when the correct pane was swapped into that split. The operator never sees tool-created output because the code hardcodes window `0` as the host viewport.

**Deterministic check discovered during investigation:** Do not use focus alone to identify Pi's tab. Prefer environment variables when available. The reliable check is:
1. read the current `TMUX_PANE` from Pi's process environment
2. treat that pane as the source of truth for Pi's own tmux location (`session_name`, `window_index`, `pane_index`)
3. capture that pane's visible content with `tmux capture-pane -p -t $TMUX_PANE`
4. enumerate visible iTerm2 sessions with `it2api list-sessions`
5. fetch each candidate buffer with `it2api get-buffer <session-id>`
6. match the captured tmux pane content against the iTerm2 buffers and pick the strongest match

This identifies **the tab Pi is running in**, not merely the tab that currently has focus. If `TMUX_PANE` is present, use it as the primary source of truth instead of re-deriving host location from broader tmux session queries.

**Fix direction:** Stop assuming host window `0`. Resolve Pi's actual host location from `TMUX_PANE`, then target that session/window pair consistently for `ensureViewPane`, `swapViewPane`, `attach`, visible-window bookkeeping, and kill/close logic. The investigation should compare:
- the current Pi tab/session from `TMUX_PANE` first, then the deterministic `it2api get-buffer` content match as external confirmation
- the current focus from `it2api show-focus` only as a secondary signal
- the tmux integration owner from `it2api list-tmux-connections`
- the host session and host window cached in `state.ts`
- whether any remaining code path still hardcodes `:0` for host-pane operations

**Verification:** After fix:
1. Identify Pi's own tab with the deterministic `TMUX_PANE` + buffer-match check
2. Confirm Pi's own tmux location, for example `session 13 window 2 pane %58`
3. Run `tmux run` from that tab
4. Ask the operator whether the split appears in that same Pi tab/window
5. Confirm the view pane was created in Pi's actual host window, not window `0`
6. Repeat after Pi reload to ensure the mapping is stable across restarts
