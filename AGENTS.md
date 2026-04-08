# pi-tmux Agent Guidelines

## What this is

A Pi extension that provides a `tmux` tool for running and managing long-running commands in tmux sessions. Designed for iTerm2 CC (control mode) where Pi runs inside a tmux session.

## Architecture

Two tmux sessions:

- **Host session** — the CC-attached session Pi runs in. tmux assigns a numeric name (`0`, `5`, etc.) on creation. Contains the **view pane** (pane 1 of window 0) — the visible split the operator sees alongside Pi.
- **Staging session** (`{derived-name}-stg`) — hidden, not CC-attached. Each command gets its own window. `swap-pane` rotates staging windows into the view pane.

Identity:

- **Host session name** — volatile, changes every Pi restart. Detected once on session start via `tmux display-message -p '#{session_name}'`. Cached in-memory. Never persisted.
- **Derived session name** — deterministic (`pi-tmux-be23e752`), based on project directory. Persisted in Pi session entries. Used to locate the staging session.

## Design tenets

1. **tmux is the architecture, not an option.**
   - Every code path assumes tmux CC mode
   - Legacy code exists only for `/tmux-promote` (the entry ramp from bare terminal to CC)
   - Do NOT add `if (process.env.TMUX)` branches — remove them

2. **Never trust in-memory state over tmux.**
   - tmux is the source of truth for sessions, windows, panes
   - If in-memory tracking disagrees with `tmux list-*`, tmux wins
   - Caches are for performance, not authority

3. **Staging windows are the stable identifiers.**
   - Pane IDs move between sessions on `swap-pane`
   - Window names and indices in the staging session do not
   - All pane resolution (peek, close, focus, resume, mute) goes through staging windows, never pane-level metadata

4. **The model must know what it cannot see.**
   - If output is truncated: say how many lines were omitted
   - If a pane was killed externally: detect it, do not report stale state
   - The model makes decisions based on tool output — incomplete information causes wrong decisions

5. **The operator must see what the model does.**
   - Every command must produce visible output in the view pane
   - Invisible panes, silent failures, no-op stubs = bugs
   - If the operator cannot see it, it did not happen

6. **Test live before declaring it works.**
   - Unit tests verify logic
   - Only live testing in tmux CC verifies visibility and swap behavior
   - Ask the operator what they see — agent assertions alone are not validation

7. **Detect and warn, do not silently override.**
   - Missing jixiuf fork, kitty-keys, extended-keys → warn the operator
   - Do NOT force-set options that belong in the operator's `~/.tmux.conf`

8. **State is initialized once and cached.**
   - Host session, settings, derived name: resolved on session start, cached for process lifetime
   - Re-detection only on error, max 3 retries
   - Volatile values (host session name) are never persisted

## Working practices

### Understand before changing

- Read the relevant source files and recent `git log --oneline -20` before touching anything
- If something is broken, identify the exact commit or code path that caused it
- Do NOT guess at fixes — analyze first

Example: a split stopped appearing → `git log -p -- extensions/terminal-tmux.ts` to find which commit changed `openTerminal`

### Test manually with the operator

- Every behavioral change gets a live test in tmux CC
- Run the command, then ask the operator what they see
- The operator's answer is the only valid signal
- Use explicit questioning format for every live check so a cold reader can follow the validation sequence

**Before asking the operator, verify with `it2api` first:**
1. Identify Pi's own tab with `TMUX_PANE` + `it2api get-buffer` content matching (not `show-focus`)
2. Check whether a split actually exists in that tab via `it2api show-hierarchy`
3. Only then ask the operator for visual confirmation
4. Never ask the operator to confirm something you have not already verified programmatically

Example:
```
Agent: [runs it2api show-hierarchy, confirms split exists in Pi's tab]
Agent: "I see the split in your tab via it2api. Do you see VERIFY-A in the split?"
Operator: "yes" / "no, nothing changed"
```

Do NOT:
- Assume a tmux command worked because exit code was 0
- Declare "it works" without operator confirmation
- Ask the operator before verifying with it2api
- Use `it2api show-focus` to identify Pi's tab (focus can be on a different tab)
- Write code to fix something before verifying the symptom live

### Document issues immediately

When a test reveals a problem:

1. Add it to `docs/engineering/open-issues.md` immediately, before attempting a fix
2. Assign a code (e.g. `PANE-META`, `FOCUS-LEAK`)
3. Include:
   - Exact observable symptom
   - Why it matters (what goes wrong for the model or operator)
   - Root cause
   - Verification sequence that must pass after the fix

### Keep documentation current

- Code changes that affect architecture, issues, or roadmap → update those docs in the same session
- `AGENTS.md` tenets change only when design principles change
- Working practices change only when the development process changes
- `docs/ROADMAP.md` and `docs/engineering/open-issues.md` are living documents — update continuously

### Commits and tags

- **Small, frequent commits.** Each passes typecheck and tests.
- **Never amend.** Fix forward.
- **Push after every commit.** Remote always matches local.
- **Pull on local install** after every push:
  ```bash
  cd ~/.pi/agent/git/.../pi-tmux && git pull
  ```
- **If the operator must reload Pi for the new code to run, stop before final live verification.**
  1. finish the implementation slice
  2. run typecheck and tests
  3. commit and push
  4. pull the installed copy under `~/.pi/agent/git/.../pi-tmux`
  5. tell the operator to reload Pi
  6. only then run the final tmux CC verification sequence with the operator
- **Do not ask whether to do this workflow.** If the change needs a reload before live validation, follow it automatically and report where you stopped.
- **Tag stable checkpoints:**
  ```bash
  git tag -a v1.3.1-pane-meta -m "PANE-META fixed, verification sequence passes"
  ```
  Tags are rollback targets when a later change introduces a regression.

### Write for cold readers

- Every document, commit message, and issue description must be clear to someone who has never seen this codebase
- No vague terms ("fix issues", "improve handling", "clean up")
- No assumed knowledge — if a sentence requires context, add the context

Do NOT: `"Fixed the attach bug"` → DO: `"fix: actionAttach early return bypassed openTerminal in tmux mode"`

### Commit message discipline (versioning)

This repo uses semantic-release. Commit types map directly to npm version bumps — be conservative:

| Prefix | Bump | Use when |
|--------|------|----------|
| `fix:` | patch | bug fix, behavioral correction |
| `feat:` | minor | genuinely new tool action or capability exposed to Pi users |
| `feat!:` / `BREAKING CHANGE:` | **major** | public tool API breaks for downstream Pi installs — almost never |
| `chore:` `docs:` `refactor:` `test:` `ci:` | none | everything else |

Rules:
- Internal refactors, session state changes, tmux command changes → `refactor:` or `fix:`, never `feat!:`
- A new `action:` value in the tool schema → `feat:`
- Removing or renaming an existing `action:` value that Pi users depend on → `feat!:` (rare)
- When in doubt, use `fix:`. Under-bumping is recoverable; burned major versions are permanent.

### Before every commit

- `npm run typecheck` passes
- `bun test` passes
- No `@ts-ignore`, `as any`, `eslint-disable`
- No modifications to deprecated files (`terminal-legacy.ts`, `terminal.ts`)

## Reference

Run `tree -L 2 --gitignore` to orient in the codebase.

Documentation:

- `AGENTS.md` — this file. Design tenets and working practices.
- `docs/ROADMAP.md` — execution order for all tracked work, each with an issue code. Start here.
- `docs/engineering/open-issues.md` — active defects: PANE-META, OUTPUT-TRACK, COMPLETE-BUILTIN, FOCUS-LEAK, ATTACH-VERIFY. Each has symptoms, root cause, and verification criteria.
- `docs/engineering/` — additional engineering documents. The roadmap links to relevant ones.
