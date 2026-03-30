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

### LEGACY-GATE (fixed — all phases)

The extension pretended to work outside tmux. Legacy code paths for iTerm2 Python API, AppleScript, and terminal-specific CLI tools were untested and added branching complexity to every action function.

Fixed in three phases:
1. Phase 1: gated the extension behind `process.env.TMUX` in `index.ts`. Outside tmux: only `/tmux-promote`, warning on session_start, tool returns error.
2. Phase 2: removed all `if (process.env.TMUX)` branches from `actions.ts`. Introduced `HostTarget` object replacing positional `hostSession`/`hostWindowIndex` args.
3. Phase 2 continued: deleted `terminal.ts` dispatcher, `terminal-legacy.ts`, dead signals code. Moved `getActiveiTermSession` into `promote.ts`.

Deleted files: `terminal.ts`, `terminal-legacy.ts`, `terminal-legacy.test.ts`.
Deleted exports: `trackCompletion`, `sendCommand`, `createWindowWithCommand`, `startCommandInFirstWindow`, `checkSilence`, `AttachOptions`.

### SWAP-SHUFFLE (fixed)

After multiple `run` + auto-focus cycles, pane contents got rotated across staging windows because `swap-pane` displaced the current view pane into the wrong staging window. `peek` and `focus` by name returned the wrong output.

Fixed by replacing `@pi_staging_index` (return-address label + two-swap sequence) with `@pi_name` (logical identity label + single swap by pane ID). `listManagedPanes` now discovers panes by `@pi_name` across both the staging session and the view pane. Displaced panes from swaps are harmless — identity is the `@pi_name` label, not the tmux window position.

### HOST-PLUMBING (fixed)

Every action function took `hostSession?: string, hostWindowIndex = 0` as separate optional positional arguments. Missing one silently defaulted to `0` and targeted the wrong tmux window.

Fixed by replacing with a single required `HostTarget` object:
```typescript
interface HostTarget {
  session: string;
  windowIndex: number;
}
```
One object, one parameter, impossible to partially forget. Done as part of LEGACY-GATE phase 2.

### OUTPUT-TRACK (fixed)

Completion notifications showed the last 20 lines of output with no indication of how many lines were omitted. The model could not distinguish "20 lines total" from "20 lines out of 500."

Fixed by capturing full scrollback (`capture-pane -S -`) in both completion notifications and peek. Completion messages now include `(N lines total, showing last 20)` when output is truncated. Peek accepts a `limit` parameter (default 50) and reports truncation metadata when output exceeds the limit.

Note: uses tmux scrollback buffer (typically 2000 lines). For commands that produce more output than the scrollback limit, older output is still lost. A future enhancement could use `pipe-pane` to log to files, but the scrollback approach covers the common case.

### FOCUS-LEAK: focus event escape sequences leak into view pane output

**Status:** open — needs research

**What happens:** `^[[I` and `^[[O` appear as raw text in the view pane when the operator clicks in and out of the split.

**Why this matters:** The operator sees garbage characters. Captured output (peek, completion) includes them too.

**Failed approaches:**
1. `send-keys` with `\x1b[?1004l` — writes to pane stdin. Shell interprets it as input, echoes `1004l` as literal text.
2. `printf '\x1b[?1004l' > /dev/ttysNNN` — writes to pane tty output side. Works per-pane but couples to swap timing and is fragile.
3. `set-option -t SESSION focus-events off` — `focus-events` is a tmux **server** option. Any `set-option` targeting any session still changes it globally, breaking Pi's own focus handling and other tmux users.

**Constraints:**
- Cannot change `focus-events` at any scope — it is strictly server-global.
- Cannot write escape sequences to pane stdin — the shell processes them as input.
- Must not affect Pi's host session, other tmux sessions, or operator's tmux config.

**Research needed:**
- Does the jixiuf tmux fork add per-pane or per-window focus-events control?
- Does tmux have a `terminal-features` or `terminal-overrides` mechanism that can disable the `focus` feature for specific panes?
- Is there a tmux hook (`after-swap-pane`, `pane-focus-in`) that could suppress focus reporting for the view pane specifically?
- Can `capture-pane` be called with flags that strip these sequences, or is post-processing the only option?

---

### COMPLETE-BUILTIN (fixed)

Shell builtins like `read` and `wait` caused premature completion because `pane_current_command` stays as the shell name. The tracker fired after 5 ticks (~1.25s) even though the shell was still blocking inside the builtin.

Fixed by requiring `seenNonShell` to be true before firing completion. The tracker only fires when it observes a non-shell `pane_current_command` (external process) and then sees it return to the shell. For builtins, `silenceTimeout` handles the "waiting for input" case. Added a 5-minute max poll duration safety net.

---

## Active issues

(none currently)

---

## Verification discipline

Before asking the operator to confirm visible behavior:
1. Identify Pi's own tab using `TMUX_PANE` + `it2api get-buffer` content matching — not `show-focus`
2. Check whether a split exists in that tab via `it2api show-hierarchy`
3. Only then ask the operator for visual confirmation
