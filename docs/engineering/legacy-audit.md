# LEGACY-GATE: Legacy Code Audit

## Status: non-tmux mode is deprecated, tmux CC is the only supported path

The extension was originally built to work outside tmux, using iTerm2's Python API (`it2api`), AppleScript (`osascript`), and terminal-specific CLI tools to open tabs and splits. tmux CC mode was added later as a second code path. Both paths now coexist via `if (process.env.TMUX)` branches in every action function. The non-tmux path has not been tested since the CC mode was introduced, adds branching complexity to every action, and includes dead code that actively interferes with the tmux path (see `actionClear` fallthrough below).

## What must survive

`promote.ts` and one function from `terminal-legacy.ts`. The `/tmux-promote` command is the entry point for operators who launch Pi outside tmux. It creates a tmux session, starts a new Pi process inside it, opens an iTerm2 tab with `tmux -CC attach`, and shuts down the original Pi process. It needs:

- `terminal-legacy.ts` `getActiveiTermSession()` — gets pi's current iTerm2 session ID for closing the old tab after promote
- `it2api create-tab` — opens the new tab with CC attach

Everything else in `terminal-legacy.ts` (the `openLegacy` function with its iTerm/Terminal.app/kitty/ghostty/WezTerm switch) is dead code once we gate behind promote.

## Dead code in tmux mode

### `terminal.ts` `attachToSession()`
Never called in tmux mode. `actionAttach` bypasses it and calls `openTerminal` from `terminal-tmux.ts` directly. `attachToSession` re-derives the session name from cwd via `deriveSessionName()`, ignoring the state module's persisted session name. If it were called, it would target the wrong tmux session.

### `terminal.ts` re-exports (`hasAttachedPane`, `closeAttachedSessions`, `openTerminal`)
`terminal.ts` loads the correct implementation at startup (tmux or legacy) and re-exports three functions. However, tmux-mode code in `actions.ts` bypasses these re-exports and uses `require("./terminal-tmux.js")` directly. This creates two import paths to the same functions, making it unclear which is authoritative.

### Legacy branches in `actions.ts`
Every action function (`actionRun`, `actionAttach`, `actionFocus`, `actionClose`, `actionPeek`, `actionList`, `actionKill`, `actionClear`, `actionMute`) contains an `if (process.env.TMUX) { ... }` block for the CC path followed by an `else`/fallthrough block for the legacy window-per-command model. The legacy model creates one tmux window per command in the main session (no staging, no swap-pane). This accounts for approximately 100 lines of code that is never executed in tmux mode.

### `actionClear` fallthrough
The tmux branch in `actionClear` queries `listManagedPanes()`, which returns an empty list due to PANE-META. When the list is empty, execution falls through to the legacy `list-windows` + `pgrep` path below the `if (process.env.TMUX)` block. That legacy path queries `commandSession(session)` which returns the staging session name, but then operates on its windows using the legacy idle-detection logic. This produces incorrect results because the legacy path does not understand the staging architecture. Fixing PANE-META would make the tmux branch work, but the fallthrough itself is a bug that should be eliminated by deleting the legacy branch.

### `source-file ~/.config/pi-tmux/tmux.conf`
Only executed in the legacy `actionRun` path when creating a new tmux session outside CC mode. In tmux CC mode, the staging session is created by `ensureStagingSession()` which does not source this file. The staging session inherits all options from the tmux server's global config (`~/.tmux.conf`). The pi-tmux conf file (`~/.config/pi-tmux/tmux.conf`) currently sets only `mouse on`, which is already set globally.

## Removal plan

### LEGACY-GATE phase 1: Gate
- On session_start: if `!process.env.TMUX`, show warning widget, register only `/tmux-promote`, return error from tool
- Follows the ACM pattern from pi-context
- No code deletion yet — just a runtime gate

### LEGACY-GATE phase 2: Remove legacy code entirely
- Delete all `else` branches after `if (process.env.TMUX)` in `actions.ts`
- Remove `process.env.TMUX` checks entirely — tmux is the only path
- Delete `terminal.ts` dispatcher
- Delete `terminal-legacy.ts` completely
- Move `getActiveiTermSession()` into `promote.ts` (its only consumer)
- Rename `terminal-tmux.ts` to `terminal.ts` — it is the terminal implementation, not a variant
- Remove `attachToSession()` — dead code
- Remove `AttachOptions` and `piSessionId` from `types.ts` if no longer referenced

### LEGACY-GATE phase 3: Restructure
- `actions.ts` becomes linear — no branching, every action assumes tmux
- `hostSession` plumbing simplifies if promote always creates a named session
- Consider renaming the host session on promote to the derived name, eliminating the host/command session split entirely
- File count drops: `terminal-legacy.ts` gone, `terminal.ts` dispatcher gone, `terminal-tmux.ts` becomes `terminal.ts`
- The codebase structure should reflect that tmux CC is not an alternative — it is the architecture

### End state
After all phases, the codebase has:
- No `process.env.TMUX` checks in action logic
- No `terminal-legacy.ts`
- No `terminal.ts` dispatcher
- `terminal.ts` (renamed from `terminal-tmux.ts`) as the sole terminal implementation
- `promote.ts` as the only file that handles the outside-tmux case, self-contained
- `actions.ts` with clean, linear tmux-only logic
