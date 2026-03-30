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

### FOCUS-LEAK (fixed)

`^[[I` / `^[[O` focus event escape sequences leaked into the visible view pane while a process was running and the operator clicked in and out of the split.

**Root cause:** the shell inside the pane enables focus reporting with `\e[?1004h`, which sets tmux pane mode `MODE_FOCUSON`. When the pane is visible, tmux forwards focus-in/out events as `\e[I` / `\e[O`. Because the visible command pane is usually just printing output, those sequences appear as raw text in scrollback and `peek`.

**What did not work:**
1. Disabling tmux server option `focus-events` — unrelated in iTerm2 CC mode for this case.
2. Prefixing the command with `printf '\e[?1004l'` — only helped for the initially visible pane and failed after later `swap-pane` cycles.
3. Writing `\e[?1004l` at pane creation time — zsh re-enabled focus reporting during startup.

**Fix:** after every `swap-pane` into the host view pane, write `\e[?1004l` to the pane's pty slave. That clears `MODE_FOCUSON` for the pane after it has entered the visible iTerm2 session context.

**Verified 2026-03-30:**
- three long-running panes (`pane-a`, `pane-b`, `pane-c`)
- repeated `focus` swaps between panes
- operator clicked in/out on each visible pane
- `peek all` showed clean output with no `^[[I` / `^[[O` in any pane

---

### COMPLETE-BUILTIN (fixed)

Shell builtins like `read` and `wait` caused premature completion because `pane_current_command` stays as the shell name. The tracker fired after 5 ticks (~1.25s) even though the shell was still blocking inside the builtin.

Fixed by requiring `seenNonShell` to be true before firing completion. The tracker only fires when it observes a non-shell `pane_current_command` (external process) and then sees it return to the shell. For builtins, `silenceTimeout` handles the "waiting for input" case. Added a 5-minute max poll duration safety net.

### LIST-ATTACHED (fixed)

`tmux list` reported `(attached)` in the header even when the host view pane was gone.

Fixed by making `actionList()` call `hasAttachedPane(host.session, host.windowIndex)` and thread the real boolean through both the header text and `details.attached`.

**Verification sequence:**
1. create at least one pane with `tmux run`
2. close the visible pane with `tmux close`
3. run `tmux list` and confirm it reports `(detached)` when no host view pane exists
4. run `tmux attach` and confirm it reports `Already attached.` only when the split is actually present

---

## Verification discipline

Before asking the operator to confirm visible behavior:
1. Identify Pi's own tab using `TMUX_PANE` + `it2api get-buffer` content matching — not `show-focus`
2. Check whether a split exists in that tab via `it2api show-hierarchy`
3. Only then ask the operator for visual confirmation
