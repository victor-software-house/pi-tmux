# Legacy Code Audit

## Status: non-tmux mode is deprecated, tmux CC is the only supported path

The extension was originally built for outside-tmux use (it2api, osascript, etc.) and later gained tmux CC mode. Both paths coexist in the codebase via `if (process.env.TMUX)` branches. The non-tmux path is untested, adds complexity, and should be removed.

## What must survive

`promote.ts` and the subset of `terminal-legacy.ts` it depends on. The promote command is the entry point for users not yet in tmux — it creates a tmux session and re-launches pi inside it via `tmux -CC attach`. It needs:

- `terminal-legacy.ts` `getActiveiTermSession()` — gets pi's current iTerm2 session ID for closing the old tab after promote
- `it2api create-tab` — opens the new tab with CC attach

Everything else in `terminal-legacy.ts` (the `openLegacy` function with its iTerm/Terminal.app/kitty/ghostty/WezTerm switch) is dead code once we gate behind promote.

## Dead code in tmux mode

### `terminal.ts` `attachToSession()`
Never called in tmux mode. `actionAttach` calls `openTerminal` from `terminal-tmux.ts` directly. The function re-derives the session name from cwd (ignoring the state module) and would target the wrong session.

### `terminal.ts` re-exports (`hasAttachedPane`, `closeAttachedSessions`, `openTerminal`)
The dispatcher loads the right impl at startup, but tmux-mode actions bypass these re-exports and `require("./terminal-tmux.js")` directly. Two import paths for the same functions — fragile and confusing.

### Legacy branches in `actions.ts`
Every action has an `if (process.env.TMUX) { ... }` tmux branch followed by legacy code. The legacy code uses the window-per-command model (one tmux window per run, no staging, no swap-pane). Approximately 100 lines across all actions.

### `actionClear` fallthrough
The tmux branch in `actionClear` queries `listManagedPanes` (broken due to PANE-META). If it returns empty, execution falls through to the legacy `list-windows` + `pgrep` path, which operates on the wrong session in tmux mode.

### `source-file ~/.config/pi-tmux/tmux.conf`
Only called in the legacy `actionRun` path when creating a new session. In tmux mode, the staging session inherits global config. The conf file currently only sets `mouse on` which is already global.

## Removal plan

### Phase 1: Gate (roadmap item "Disable non-tmux mode")
- On session_start: if `!process.env.TMUX`, show warning widget, register only `/tmux-promote`, return error from tool
- Follows the ACM pattern from pi-context
- No code deletion yet — just a runtime gate

### Phase 2: Remove legacy branches
- Delete all `else` branches after `if (process.env.TMUX)` in `actions.ts`
- Remove `process.env.TMUX` checks entirely — tmux is the only path
- Delete `terminal.ts` dispatcher (import `terminal-tmux.ts` directly)
- Trim `terminal-legacy.ts` to only `getActiveiTermSession()` for promote
- Remove `attachToSession()` from `terminal.ts`

### Phase 3: Simplify
- `actions.ts` no longer needs `hostSession` plumbing if promote always creates a named session
- Consider renaming the host session on promote to the derived name, eliminating the host/command session split entirely
