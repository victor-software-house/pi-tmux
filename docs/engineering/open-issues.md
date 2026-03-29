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

## 4. `attach` returns "View pane already visible" without verifying visibility

**Symptom:** `attach` says visible but user may not see a split if the view pane was killed externally.

**Direction:** Before returning "already visible", verify pane 1 exists in host `0:` via `list-panes`. If missing, recreate.
