# Open Issues — tmux CC mode

## 1. Managed pane ID tracking points to view pane, not staging pane

**Symptom:** `peek` by name fails after run. Tool returns `%20` (view pane in host session) instead of the staging pane (`%19`).

**Root cause:** `ensureViewPane` creates pane 1 in host session via `split-window -P -F "#{pane_id}"`. Then `actionRun` likely captures this ID instead of the staging pane ID. After `swap-pane`, the pane IDs shuffle between host and staging.

**Direction:** `markManagedPane` and `getPaneId` should always track the **staging** pane ID, not the view pane. The view pane is a display slot — its content changes via `swap-pane`. Track panes by their staging session position, not by ID in the host.

## 2. Stale `@pi_title` on reused staging panes

**Symptom:** Pane `%19` has `@pi_title=test1` instead of `reload-verify` after window reuse.

**Root cause:** `setManagedPaneTitle` targets the pane ID, but after `swap-pane` the pane moved to a different position. The tmux user option (`@pi_title`) stays on the original pane.

**Direction:** Update `@pi_title` on the staging pane **after** respawn, before swap. Or always resolve by staging window index instead of pane ID.

## 3. `peek` resolves by managed pane name, misses swapped panes

**Symptom:** `peek reload-verify` returns "No pane" because managed pane list has stale titles.

**Direction:** `peek` in tmux mode should resolve the target against staging window names (`tmux list-windows -t stg`), not managed pane metadata. Window names are set by `rename-window` and survive swaps.

## 4. Completion notifications truncate output to 20 lines

**Symptom:** Model receives only the last 20 non-empty lines of command output on completion. Cannot debug failures from long commands.

**Root cause:** `filterPaneOutput()` in `signals.ts` slices to 20 lines. `capture-pane -S -50` only grabs 50 lines from scrollback.

**Direction:**
- Keep current notification behavior (last N lines of output)
- Include metadata: total lines since command start, how many lines were omitted
- The model can then decide to `peek` with a range if it needs more context
- `peek` must support `start` and `end` line params for arbitrary range reads via `tmux capture-pane -p -S {start} -E {end}`
**Tracking output per command:**
- Total output position = `#{history_size} + #{cursor_y}` (monotonically increasing)
- Before `send-keys`: snapshot as `cmd_start`, store as `@pi_cmd_start` on the pane
- On completion: `cmd_end = history_size + cursor_y`, delta = `cmd_end - cmd_start`
- Capture this command's output: `capture-pane -S -(delta) -E -1`
- Notification includes last N lines + "X more lines from this command" so the model knows what to peek

**Peek with range:**
- `peek` supports `start`/`end` line params via `capture-pane -p -S {start} -E {end}`
- Defaults to last N lines of the current command's output (using `@pi_cmd_start`)
- Note: if output exceeds `history-limit` (50000), oldest lines are silently lost

## 5. `attach` returns "View pane already visible" without verifying visibility

**Symptom:** `attach` says visible but user may not see a split if the view pane was killed externally.

**Direction:** Before returning "already visible", verify pane 1 exists in host `0:` via `list-panes`. If missing, recreate.
