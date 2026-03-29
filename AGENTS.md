# pi-tmux Agent Guidelines

## What this is

A Pi extension that provides a `tmux` tool for running and managing long-running commands in tmux sessions. Designed for iTerm2 CC (control mode) where Pi runs inside a tmux session.

## Tenets

1. **tmux is the architecture, not an option.** Every code path assumes tmux CC mode. There is no supported non-tmux mode. Legacy code exists only to support `/tmux-promote`, which moves the Pi process from a bare terminal into a tmux CC session. Do not add `if (process.env.TMUX)` branches — remove them.

2. **Never trust in-memory state over tmux.** tmux is the source of truth for sessions, windows, panes, and their state. If in-memory tracking disagrees with `tmux list-*`, tmux wins. Caches are for performance, not authority.

3. **Staging windows are the stable identifiers.** Pane IDs move between sessions on `swap-pane`. Window names and indices in the staging session do not. All pane resolution (peek, close, focus, resume, mute) must go through staging windows, never through pane-level metadata.

4. **The model must know what it cannot see.** If output is truncated, say how much was omitted and from where. If a pane was killed externally, detect it instead of reporting stale state. The model makes decisions based on tool output — incomplete or stale information leads to wrong decisions.

5. **The operator must see what the model does.** Every command the model runs must produce visible output in the view pane (the iTerm2 split alongside Pi's own pane). Invisible panes, silent failures, and no-op stubs are bugs. If the operator cannot see it, it did not happen.

6. **Test live before declaring it works.** Unit tests verify logic. Only live testing in a tmux CC session verifies visibility, swap behavior, and iTerm2 integration. Use `it2api list-sessions` to confirm panes exist. Ask the operator what they see.

7. **Detect and warn, do not silently override.** If the tmux environment is missing capabilities (jixiuf fork, kitty-keys, extended-keys), warn the operator. Do not force-set options that belong in the operator's global config.

8. **State is initialized once and cached.** Host session name, settings, and the derived tmux session name are resolved on session start and cached in-memory for the lifetime of the Pi process. Re-detection of the host session happens only when a tmux operation fails, with a maximum of 3 retries before giving up. Volatile runtime values (host session name) are never written to Pi session entries — only the derived session name and the originating cwd are persisted.

## Architecture

In tmux CC mode, the extension uses two sessions:
- **Host session** — the CC-attached session Pi runs in (auto-detected, numeric name like `0`, `5`). The view pane (visible split) lives here as pane 1 of window 0.
- **Staging session** (`{derived-name}-stg`) — hidden, not CC-attached. Commands run here in separate windows. `swap-pane` rotates staging panes in and out of the view pane.

The host session name is assigned by tmux when the session is created (e.g. `0`, `2`, `5`) and changes every time Pi restarts or promotes into a new tmux session. It is detected once on session start via `tmux display-message -p '#{session_name}'` and cached in-memory for the lifetime of the Pi process. It is never persisted because it would be stale on the next run. The derived session name (project directory slug + md5 hash, e.g. `pi-tmux-be23e752`) is persisted in Pi session entries so the staging session can be located across tool calls within the same Pi session.

## Key files

| File | Purpose |
|---|---|
| `extensions/index.ts` | Tool registration, lifecycle hooks, action dispatch |
| `extensions/actions.ts` | All tmux actions (run, attach, focus, peek, list, close, kill, mute) |
| `extensions/session.ts` | tmux primitives: session/window/pane management, staging, view pane |
| `extensions/state.ts` | Durable session identity persisted in Pi session entries |
| `extensions/terminal-tmux.ts` | CC-mode terminal: visible split/tab via split-window, pane tracking |
| `extensions/terminal-legacy.ts` | **Deprecated.** Outside-tmux fallback. Do not modify. Scheduled for deletion (LEGACY-GATE). |
| `extensions/terminal.ts` | **Deprecated.** Dispatcher. Scheduled for deletion (LEGACY-GATE). |
| `extensions/signals.ts` | Completion tracking, silence notifications |
| `extensions/promote.ts` | /tmux-promote command — the only outside-tmux entry point |
| `extensions/settings.ts` | User-configurable settings |
| `extensions/tool-builder.ts` | Dynamic tool schema/description based on settings |

## Known issues

See `docs/engineering/open-issues.md` — five tracked issues (PANE-META, OUTPUT-TRACK, COMPLETE-BUILTIN, FOCUS-LEAK, ATTACH-VERIFY) with exact symptoms, root causes, and verification criteria. The most critical is PANE-META (pane metadata broken by swap-pane), which blocks list/peek/close/focus/resume by name.

## Legacy code

See `docs/engineering/legacy-audit.md` (LEGACY-GATE) — non-tmux mode is deprecated. The codebase has ~100 lines of legacy branches in `actions.ts` plus a dispatcher (`terminal.ts`) and full outside-tmux terminal implementation (`terminal-legacy.ts`). Only `promote.ts` and `getActiveiTermSession()` survive. Do not add new code to the legacy paths.

## Roadmap

See `docs/ROADMAP.md` for execution order and all tracked work items with codes.

## Git practices

- **Commit frequently.** Small, focused commits. Each commit should be a coherent change that passes typecheck and tests.
- **Never amend.** History is append-only. If a commit is wrong, fix forward with a new commit.
- **Push after every commit.** Remote must always reflect local state.
- **Tag working checkpoints.** After completing a roadmap item or reaching a stable state, tag with `git tag -a v{version}-{code} -m "description"`. These are rollback targets when a later change introduces a regression.
- **Pull on the local install** (`~/.pi/agent/git/.../pi-tmux`) after every push so the live extension matches.

## Before committing

- `npm run typecheck` must pass
- `bun test` must pass (143+ tests)
- Do not add `@ts-ignore`, `as any`, `eslint-disable`
- Do not add new `if (process.env.TMUX)` branches — tmux is the only path
- Do not modify `terminal-legacy.ts` or `terminal.ts` — they are scheduled for deletion
- Test live in tmux CC mode before declaring anything works
- If you change pane resolution logic, run the PANE-META verification sequence from `open-issues.md`

## Testing

The tmux tool must be tested live inside a tmux CC session (iTerm2). Unit tests cover session derivation, settings, and action routing but cannot verify CC-mode visibility or swap behavior. Always validate with the operator.

Test commands to verify visibility (replace HOST and STAGING with actual session names):
```bash
# Confirm the split exists — the host session should show two panes, not one
tmux list-panes -t '=HOST:0' -F '#{pane_index} #{pane_id} #{pane_current_command}'

# Confirm iTerm2 sees the split — look for reduced dimensions (e.g. 75x43 instead of 150x45)
it2api list-sessions

# Confirm staging window names match the names passed to run
tmux list-windows -t '=STAGING' -F '#{window_index} #{window_name}'
```
