# Open Issues — tmux CC mode

## 1. Managed pane ID tracking points to view pane, not staging pane

**Symptom:** `peek` by name fails after run. Tool returns `%20` (view pane in host session) instead of the staging pane (`%19`).

**Root cause:** `ensureViewPane` creates pane 1 in host session via `split-window -P -F "#{pane_id}"`. Then `actionRun` likely captures this ID instead of the staging pane ID. After `swap-pane`, the pane IDs shuffle between host and staging.

**Direction:** `markManagedPane` and `getPaneId` should always track the **staging** pane ID, not the view pane. The view pane is a display slot — its content changes via `swap-pane`. Track panes by their staging session position, not by ID in the host.

## 2. `@pi_managed` / `@pi_title` pane metadata is fundamentally broken with swap-pane

**Symptom:** After multiple runs, `list`, `peek`, `close`, `focus` by name or index all fail or resolve to wrong panes. `@pi_title` ends up on the wrong pane.

**Root cause:** `swap-pane` moves pane IDs between positions but `@pi_*` user options follow the pane ID, not the staging window position. After each swap, metadata is on the wrong pane.

**Confirmed:** Staging **window names** (`tmux list-windows -F '#{window_name}'`) are always correct and survive swaps. The staging windows are the real source of truth.

**Direction:** Remove `@pi_managed` / `@pi_title` / `@pi_owner_session` pane metadata entirely. Replace `listManagedPanes` / `resolveManagedPane` with staging window queries:
- Resolve by name: `tmux list-windows -t stg -F '#{window_index}\t#{window_name}'` and match
- Resolve by index: direct staging window index
- `peek`: `capture-pane -t stg:{index}.0`
- `close`: `kill-window -t stg:{index}`
- `list`: `list-windows -t stg`
- This eliminates all pane ID tracking issues in one change

## 4. Completion notifications truncate output to 20 lines

**Symptom:** Model receives only the last 20 non-empty lines of command output on completion. Cannot debug failures from long commands.

**Root cause:** `filterPaneOutput()` in `signals.ts` slices to 20 lines. `capture-pane -S -50` only grabs 50 lines from scrollback.

**Direction:**
- Keep current notification behavior (last N lines of output)
- Include metadata: total lines since command start, how many lines were omitted
- The model can then decide to `peek` with a range if it needs more context
- `peek` must support `start` and `end` line params for arbitrary range reads via `tmux capture-pane -p -S {start} -E {end}`
**Rejected: `history_size + cursor_y` tracking** — fragile. Breaks on pane resize (text reflow), terminal clear, alternate screen apps, and `history-limit` overflow.

**Recommended: `tmux pipe-pane` to log files:**
- On pane creation: `tmux pipe-pane -t %ID 'cat >> /tmp/pi-tmux/pane-%ID.log'`
- Before `send-keys`: record byte offset `cmd_start = wc -c < logfile`
- On completion: read from `cmd_start` with `tail -c +$cmd_start logfile`
- Immune to resize, clear, alternate screen, scrollback limits
- Random access via file seek — model can read any range
- Notification includes last N lines + "X more lines from this command"
- `peek` reads from the log file with offset/limit params, not `capture-pane`
- Log files cleaned up on `kill` / session end

## 5. Completion tracker fires prematurely for shell builtins (read, wait, etc.)

**Symptom:** `read -r` blocks for user input but the completion tracker sees `pane_current_command=zsh` and marks the command as finished.

**Root cause:** Shell builtins don't change the foreground process name. The tracker checks `pane_current_command` for idle shell names (zsh, bash, etc.) and can't distinguish "shell waiting for builtin" from "shell idle after command".

**Direction:** Complement `pane_current_command` with `pane_pid` subprocess check (`pgrep -P $pid`) or use shell integration markers to detect true command completion. Alternatively, use `pipe-pane` logs to detect the prompt appearing after command output.

## 6. Focus reporting escape sequences leak into swapped panes

**Symptom:** `^[[I` (focus gained) and `^[[O` (focus lost) appear as raw text in the view pane when clicking in/out.

**Root cause:** `focus-events on` in global tmux config causes tmux to send focus sequences to panes. Swapped-in panes with blocking commands (read, sleep) don't consume them, so they render as raw text.

**Direction:** Send `printf '\e[?1004l'` (disable focus reporting) to the view pane after each swap. Or set `focus-events off` per-pane if tmux supports it.

## 7. `attach` returns "View pane already visible" without verifying visibility

**Symptom:** `attach` says visible but user may not see a split if the view pane was killed externally.

**Direction:** Before returning "already visible", verify pane 1 exists in host `0:` via `list-panes`. If missing, recreate.
