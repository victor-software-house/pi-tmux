# pi-tmux Agent Guidelines

## What this is

A Pi extension that provides a `tmux` tool for running and managing long-running commands in tmux sessions. Designed for iTerm2 CC (control mode) where Pi runs inside a tmux session.

## Architecture

The extension uses two tmux sessions:

- **Host session** — the CC-attached session Pi runs in. tmux assigns it a numeric name (e.g. `0`, `5`) when the session is created. The **view pane** (pane 1 of window 0) lives here — this is the visible split the operator sees alongside Pi's own pane.
- **Staging session** (`{derived-name}-stg`) — hidden, not CC-attached. Each command runs in its own window here. `swap-pane` rotates staging windows in and out of the view pane to display different commands without creating new tabs.

The host session name changes every time Pi restarts. It is detected once via `tmux display-message -p '#{session_name}'` on session start and cached in-memory for the lifetime of the Pi process. It is never persisted. The derived session name (project directory slug + md5 hash, e.g. `pi-tmux-be23e752`) is persisted in Pi session entries so the staging session can be located across tool calls.

## Design tenets

1. **tmux is the architecture, not an option.** Every code path assumes tmux CC mode. There is no supported non-tmux mode. Legacy code exists only to support `/tmux-promote`, which moves the Pi process from a bare terminal into a tmux CC session. Do not add `if (process.env.TMUX)` branches — remove them.

2. **Never trust in-memory state over tmux.** tmux is the source of truth for sessions, windows, panes, and their state. If in-memory tracking disagrees with `tmux list-*`, tmux wins. Caches are for performance, not authority.

3. **Staging windows are the stable identifiers.** Pane IDs move between sessions on `swap-pane`. Window names and indices in the staging session do not. All pane resolution (peek, close, focus, resume, mute) must go through staging windows, never through pane-level metadata.

4. **The model must know what it cannot see.** If output is truncated, say how much was omitted and from where. If a pane was killed externally, detect it instead of reporting stale state. The model makes decisions based on tool output — incomplete or stale information leads to wrong decisions.

5. **The operator must see what the model does.** Every command the model runs must produce visible output in the view pane (the iTerm2 split alongside Pi's own pane). Invisible panes, silent failures, and no-op stubs are bugs. If the operator cannot see it, it did not happen.

6. **Test live before declaring it works.** Unit tests verify logic. Only live testing in a tmux CC session verifies visibility, swap behavior, and iTerm2 integration. Use `it2api list-sessions` to confirm panes exist. Ask the operator what they see.

7. **Detect and warn, do not silently override.** If the tmux environment is missing capabilities (jixiuf fork, kitty-keys, extended-keys), warn the operator. Do not force-set options that belong in the operator's global config.

8. **State is initialized once and cached.** Host session name, settings, and the derived tmux session name are resolved on session start and cached in-memory for the lifetime of the Pi process. Re-detection of the host session happens only when a tmux operation fails, with a maximum of 3 retries before giving up. Volatile runtime values (host session name) are never written to Pi session entries — only the derived session name and the originating cwd are persisted.

## Working practices

**Understand before changing.** Read the relevant source files and recent git history before proposing any change. If something is broken, identify the exact commit or code path that broke it. Do not guess at fixes.

**Test manually with the operator.** Every behavioral change must be tested live in a tmux CC session. The agent proposes a test, runs it, and asks the operator what they see. The operator's confirmation is the only valid signal — the agent's assertion alone is not validation.

**Document issues when found.** When a test reveals a problem, document it immediately in `docs/engineering/open-issues.md` with: a code (e.g. PANE-META), the exact observable symptom, why it matters, the root cause, and a verification sequence that must pass after the fix. This happens before any fix is attempted.

**Keep documentation current.** When code changes affect the architecture, known issues, or the roadmap, update those documents in the same working session. AGENTS.md tenets change only when the extension's design principles change. Working practices change only when the development process changes. The roadmap and open issues are living documents updated continuously.

**Commit frequently, never amend.** Each commit is a small, coherent change that passes typecheck and tests. History is append-only — if a commit is wrong, fix forward. Push after every commit. Pull on the local install (`~/.pi/agent/git/.../pi-tmux`) after every push so the live extension matches.

**Tag working checkpoints.** After completing a roadmap item or reaching a stable state, tag with `git tag -a v{version}-{code} -m "description"`. These are rollback targets when a later change introduces a regression.

**Write for cold readers.** Every document, commit message, and issue description must be unambiguous to someone with no prior context about this codebase. No vague terms, no assumed knowledge. If a sentence requires context that isn't in the document, add the context or link to where it is.

**Typecheck and test before every commit.** `npm run typecheck` and `bun test` must both pass. Do not add `@ts-ignore`, `as any`, or `eslint-disable`. Do not modify files marked as deprecated (`terminal-legacy.ts`, `terminal.ts`) — they are scheduled for deletion.

## Reference

Run `tree -L 2 --gitignore` to orient in the codebase.

**Documentation structure:**
- `AGENTS.md` — this file. Design tenets and working practices.
- `docs/ROADMAP.md` — execution order for all tracked work items, each with an issue code. Start here to understand what needs to be done and in what order.
- `docs/engineering/open-issues.md` — active defects with exact symptoms, root causes, and verification sequences. Referenced by code (PANE-META, OUTPUT-TRACK, COMPLETE-BUILTIN, FOCUS-LEAK, ATTACH-VERIFY).
- `docs/engineering/` — engineering documents including the legacy code audit. The roadmap links to specific documents where relevant.
