# pi-tmux Agent Guidelines

## What this is

A Pi extension that provides a `tmux` tool for running and managing long-running commands in tmux sessions. Designed for iTerm2 CC (control mode) where Pi runs inside a tmux session.

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
| `extensions/terminal-legacy.ts` | Deprecated: outside-tmux fallback using it2api/osascript |
| `extensions/terminal.ts` | Dispatcher: loads terminal-tmux.ts or terminal-legacy.ts |
| `extensions/signals.ts` | Completion tracking, silence notifications |
| `extensions/promote.ts` | /tmux-promote command |
| `extensions/settings.ts` | User-configurable settings |
| `extensions/tool-builder.ts` | Dynamic tool schema/description based on settings |

## Known issues

See `docs/engineering/open-issues.md` — five tracked issues (PANE-META, OUTPUT-TRACK, COMPLETE-BUILTIN, FOCUS-LEAK, ATTACH-VERIFY) with exact symptoms, root causes, and verification criteria. The most critical is PANE-META (pane metadata broken by swap-pane), which blocks list/peek/close/focus/resume by name.

## Legacy code

See `docs/engineering/legacy-audit.md` — non-tmux mode is deprecated. The codebase has ~100 lines of legacy branches in `actions.ts` plus a dispatcher (`terminal.ts`) and full outside-tmux terminal implementation (`terminal-legacy.ts`). Only `promote.ts` and `getActiveiTermSession()` survive. Do not add new code to the legacy paths.

## Before committing

- `npm run typecheck` must pass
- `bun test` must pass (143+ tests)
- Do not add `@ts-ignore`, `as any`, `eslint-disable`
- Test live in tmux CC mode before declaring anything works — `it2api list-sessions` to verify visibility

## Testing

The tmux tool must be tested live inside a tmux CC session (iTerm2). Unit tests cover session derivation, settings, and action routing but cannot verify CC-mode visibility or swap behavior. Always validate with the operator.
