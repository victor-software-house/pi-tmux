# Open Issues — tmux CC mode

## Architecture

pi-tmux manages command panes across two tmux sessions:

- **Host session** — the tmux session Pi runs in. Detected from `TMUX_PANE` at startup. Contains Pi's own pane and the **view pane** (a split next to Pi that shows one command's output at a time).
- **Staging session** (`{name}-stg`) — a separate tmux session not attached to iTerm2 CC. Each command gets its own tmux window here. Command panes are created in the staging session, then swapped into the view pane with `tmux swap-pane` for display.

`swap-pane` exchanges two panes between positions. Both pane IDs move. The caller specifies source and target by pane ID or by `session:window.pane` position.

---

## Fixed issues

### PANE-META (fixed)

Old pane-option metadata (`@pi_managed`, `@pi_title`) was used to discover and identify command panes. These options travel with the pane ID through `swap-pane`, so after swaps they ended up in the wrong tmux window positions and broke `list`, `peek`, `focus`, `close`, and `resume`.

Fixed by switching to staging-window-based inventory: `list-panes -s` on the staging session lists all windows with their names. The staging window name is stable across swaps.

### HOST-MISMATCH (fixed)

The extension hardcoded host window `0` for all view pane operations. Pi actually runs in whatever tmux window `TMUX_PANE` resolves to (e.g. window `4`). The view pane was created in the wrong window and the operator never saw it.

Fixed by detecting Pi's host session and window index from `TMUX_PANE` at startup, then threading that through all view pane operations.

### ATTACH-VERIFY (fixed)

`attach` trusted an in-memory flag without verifying the view pane actually exists in tmux. If the operator manually closed the split, `attach` reported success but no split was visible.

Fixed by querying `tmux list-panes` for pane index `1` in the host window before reporting attached.

### LEGACY-GATE phase 1 (fixed)

The extension pretended to work outside tmux. Legacy code paths for iTerm2 Python API, AppleScript, and terminal-specific CLI tools were untested and added branching complexity.

Fixed by gating the entire extension behind `process.env.TMUX` in `index.ts`. Outside tmux: only `/tmux-promote` is registered, `session_start` shows a warning, and the tool returns a clear error for every action. Inside tmux: no behavior change.

---

## Active issues

### SWAP-SHUFFLE: `swap-pane` displaces command panes into wrong staging windows

**Status:** interim fix in place, proper fix documented

**What happens:** After `run name: a`, `run name: b`, `run name: c` with auto-focus, the pane contents get rotated across staging windows. Staging window named `b` contains pane `a`'s output, `c` contains `b`'s output, etc.

**Why this matters:** `peek window: b` returns the wrong command's output. The model sees incorrect data.

**Root cause:** Each `swap-pane` call exchanges the view pane with a staging pane. The displaced view pane goes to whatever staging window the new pane came from — not back to its own original window. After multiple swaps, panes are in the wrong windows.

**Current interim fix:** Each pane carries `@pi_staging_index` — a pane option labeling which staging window it belongs to. Before swapping a new pane into the view, the current view pane is returned to its labeled staging window first (two swaps per focus change). This works but adds complexity.

**Proper fix:** Stop tracking positions entirely. Each command pane should carry a `@pi_name` pane option (e.g. `"build"`). To show a pane, find it by `@pi_name` across all panes (staging session + view pane), then swap it into the view by pane ID: `swap-pane -d -s HOST:W.1 -t %PANE_ID`. Single swap. The displaced pane goes wherever — does not matter because identity is the label on the pane, not the tmux window it sits in.

This eliminates:
- `@pi_staging_index` return-address tracking
- two-swap return-then-fetch sequence
- any invariant that staging window contents must match staging window names

**Verification:** `run a`, `run b`, `run c`, then: `peek a` returns VERIFY-A, `peek b` returns VERIFY-B, `peek c` returns VERIFY-C.

---

### HOST-PLUMBING: host identity threading is fragile

**Status:** open, tracked for LEGACY-GATE phases 2-3

**What happens:** Every action function takes `hostSession?: string, hostWindowIndex = 0` as separate optional positional arguments. Missing one silently defaults to `0` and targets the wrong tmux window. This has caused multiple rounds of fixes where some call sites were updated and others were missed.

**Why this matters:** Adding or changing a parameter requires touching every call site. TypeScript does not flag a missing optional argument. Bugs only show up during live tmux CC testing.

**Fix direction:** Replace with a single required `HostTarget` object:
```typescript
interface HostTarget {
  session: string;
  windowIndex: number;
}
```
One object, one parameter, impossible to partially forget. Do this during LEGACY-GATE phases 2-3 when legacy branches are removed and action signatures are simplified.

---

### OUTPUT-TRACK: completion notifications do not report truncation

**Status:** open

**What happens:** Command completion notifications show the last 20 lines of output with no indication of how many lines were omitted.

**Why this matters:** The model cannot distinguish "20 lines total" from "20 lines out of 500." A test suite that failed early but passed at the end looks like it passed.

**Fix direction:** Use `tmux pipe-pane` to log all pane output to a file. Record byte offset before sending the command. On completion, compute total lines from the log. Include "X total lines, showing last N" in the notification. Support ranged `peek` to read any portion.

---

### COMPLETE-BUILTIN: completion tracker fires prematurely for shell builtins

**Status:** open

**What happens:** `read -r REPLY` and similar shell builtins block for input, but the completion tracker immediately marks the command as finished because `pane_current_command` still shows the shell name.

**Why this matters:** The model moves on. The operator sees the command still waiting. `silenceTimeout` never fires.

**Fix direction:** Detect shell-at-prompt vs shell-running-builtin using shell integration markers or prompt pattern detection from `pipe-pane` logs.

---

### FOCUS-LEAK: focus event escape sequences leak into pane output

**Status:** open

**What happens:** `^[[I` and `^[[O` appear as raw text in the view pane when the operator clicks in and out.

**Fix direction:** After each `swap-pane` into the view, send `\e[?1004l` to disable focus event reporting for that pane.

---

## Verification discipline

Before asking the operator to confirm visible behavior:
1. Identify Pi's own tab using `TMUX_PANE` + `it2api get-buffer` content matching — not `show-focus`
2. Check whether a split exists in that tab via `it2api show-hierarchy`
3. Only then ask the operator for visual confirmation
