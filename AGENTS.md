# pi-tmux Agent Guidelines

## What this is

A Pi extension that provides a `tmux` tool for running and managing long-running commands in tmux sessions. Designed for iTerm2 CC (control mode) where Pi runs inside a tmux session.

## Tenets

1. **tmux is the architecture, not an option.** Every code path assumes tmux CC mode. There is no supported non-tmux mode. Legacy code exists only to support `/tmux-promote` (the entry ramp). Do not add `if (process.env.TMUX)` branches — remove them.

2. **Never trust in-memory state over tmux.** tmux is the source of truth for sessions, windows, panes, and their state. If in-memory tracking disagrees with `tmux list-*`, tmux wins. Caches are for performance, not authority.

3. **Staging windows are the stable identifiers.** Pane IDs move between sessions on `swap-pane`. Window names and indices in the staging session do not. All pane resolution (peek, close, focus, resume, mute) must go through staging windows, never through pane-level metadata.

4. **The model must know what it cannot see.** If output is truncated, say how much was omitted and from where. If a pane was killed externally, detect it instead of reporting stale state. The model makes decisions based on tool output — incomplete or stale information leads to wrong decisions.

5. **The operator must see what the model does.** Every command the model runs must produce visible output in the view pane. Invisible panes, silent failures, and no-op stubs are bugs. If the operator cannot see it, it did not happen.

6. **Test live before declaring it works.** Unit tests verify logic. Only live testing in a tmux CC session verifies visibility, swap behavior, and iTerm2 integration. Use `it2api list-sessions` to confirm panes exist. Ask the operator what they see.

7. **Detect and warn, do not silently override.** If the tmux environment is missing capabilities (jixiuf fork, kitty-keys, extended-keys), warn the operator. Do not force-set options that belong in the operator's global config.

8. **State is initialized once and cached.** Host session detection, settings, and session identity are resolved on session start and cached for the lifetime of the Pi session. Re-detection happens only on error with a retry limit. Stale volatile state (like host session name) is never persisted.

## Architecture

In tmux CC mode, the extension uses two sessions:
- **Host session** — the CC-attached session Pi runs in (auto-detected, numeric name like `0`, `5`). The view pane (visible split) lives here as pane 1 of window 0.
- **Staging session** (`{derived-name}-stg`) — hidden, not CC-attached. Commands run here in separate windows. `swap-pane` rotates staging panes in and out of the view pane.

The host session name is volatile (changes every Pi restart). It is detected once per session via `tmux display-message` and cached in-memory. It is never persisted. The derived session name (hash-based) is persisted in Pi session entries for continuity across tool calls.

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
- **Tag working checkpoints.** After completing a roadmap item or reaching a stable state, tag with `git tag -a v{version}-{code} -m "description"`. These are rollback points for emergencies.
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

Test commands to verify visibility:
```bash
it2api list-sessions    # confirm pane dimensions changed (split exists)
tmux list-panes -t HOST:0  # confirm pane 1 exists
tmux list-windows -t STAGING  # confirm window names match expectations
```
