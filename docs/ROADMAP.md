# pi-tmux Roadmap

## Suggested execution order

1. **PANE-META** — Replace pane metadata with staging window queries. This unblocks list, peek, close, focus, resume, and mute. Every other improvement depends on these actions working correctly.
2. **ATTACH-VERIFY** — Small fix, eliminates a class of confusing "already visible" false positives. Do it while touching the terminal code.
3. **LEGACY-GATE** (phase 1) — Add the runtime gate so the tool stops pretending to work outside tmux. No code deletion, just a check and a warning. This prevents wasted debugging time on a path that will never be supported.
4. **LEGACY-GATE** (phases 2-3) — Delete legacy branches from `actions.ts`, delete `terminal.ts` dispatcher, delete `terminal-legacy.ts`, rename `terminal-tmux.ts` to `terminal.ts`. Include **HOST-PLUMBING** refactor: replace positional `hostSession` + `hostWindowIndex` threading with a single `HostTarget` object. Easier to do after PANE-META because `actions.ts` will already be heavily edited.
5. **OUTPUT-TRACK** — Implement `tmux pipe-pane` logging and output metadata in completion notifications. Depends on PANE-META because `peek` must resolve panes by name before ranged output reads are useful.
6. **COMPLETE-BUILTIN** — Fix premature completion for shell builtins (`read`, `wait`, etc.). Independent of other items. Lower urgency because most commands the model runs are external processes, not interactive builtins.
7. **HOST-MISMATCH** — Fix host-session to operator-visible-tab mapping before declaring the tmux CC path verified. The split currently appears in a real tmux host session, but not necessarily in the iTerm2 tab Pi is running in. Use the deterministic `TMUX_PANE` + `tmux capture-pane` + `it2api get-buffer` matching check from `docs/engineering/open-issues.md` rather than relying on focus alone.
8. **FOCUS-LEAK** — Cosmetic. Fix after the swap-pane flow is stable.
9. **CTX-SIGNAL, SCHEMA-COMPAT, MSG-DELIVERY** — Integrations with Pi runtime APIs added in v0.63-0.64. Independent of each other and of the above items.

Items 1-2 are prerequisites for everything else. Items 3-5 have ordering dependencies (noted above). Item 7 blocks final confidence in live tmux CC verification. Items 6, 8, and 9 are otherwise independent.

## Terminology

Use exact tmux names everywhere. No metaphors, no vague terms.

| Term | Meaning |
|---|---|
| tmux session | A named tmux session (e.g. `13`, `pi-tmux-be23e752-stg`) |
| tmux window | A numbered tab within a tmux session (e.g. window `4` of session `13`) |
| tmux pane | A rectangular region within a window, identified by pane ID (e.g. `%84`) |
| pane ID | Tmux's unique identifier for a pane (e.g. `%84`). Survives `swap-pane`. |
| pane option | A user-defined key-value pair on a pane (`set-option -p`). Travels with the pane ID through `swap-pane`. |
| host session | The tmux session Pi is running in. Detected from `TMUX_PANE` at startup. |
| host window | The tmux window within the host session where Pi's own pane lives. Detected from `TMUX_PANE` at startup. |
| view pane | The split pane next to Pi (pane index `1` in the host window). Shows one command's output at a time. Created by `split-window`. |
| staging session | A separate tmux session (`{name}-stg`) not attached to iTerm2 CC. Command panes are created here. |
| staging window | A tmux window in the staging session. One per command. |
| `@pi_name` | Pane option labeling a command pane with its logical name (e.g. `build`). The sole identity for a command pane. |
| `swap-pane` | Tmux command that exchanges two panes between positions. Both pane IDs move. Accepts pane IDs directly. |

---

## Critical — fix before further feature work

### PANE-META: Replace pane metadata with staging window queries
The `@pi_managed` / `@pi_title` pane metadata system is broken by `swap-pane`. This blocks `list`, `peek` by name, `close`, `focus`, `resume`, and `mute`. The staging session's window names are the correct source of truth. See `docs/engineering/open-issues.md` PANE-META for full details and verification criteria.

### LEGACY-GATE: Disable non-tmux mode, gate behind /tmux-promote
Non-tmux (legacy) code paths add complexity and are untested. Three-phase plan:
1. ~~Gate: runtime check on session_start, widget warning, tool returns error outside tmux~~ (done)
2. Remove: delete legacy branches from actions.ts, delete terminal.ts dispatcher
3. Simplify: direct imports, consider renaming host session on promote
See `docs/engineering/legacy-audit.md` for full audit of what's dead, what survives, and what actively hurts the tmux path.

Phase 1 is done. Outside tmux: only `/tmux-promote` is registered, `session_start` warns, tool returns error. Inside tmux: no change.

## High priority

### OUTPUT-TRACK: Output tracking via pipe-pane
Completion notifications silently truncate to 20 lines with no indication of what was omitted. The model cannot make informed decisions about when to peek. Implement `tmux pipe-pane` to per-pane log files, track byte offsets per command, and include omission metadata in notifications. See `docs/engineering/open-issues.md` OUTPUT-TRACK.

### COMPLETE-BUILTIN: Fix completion tracker for shell builtins
Builtins like `read` and `wait` cause premature completion because `pane_current_command` stays as the shell name. The model reports commands done before the operator has interacted. See `docs/engineering/open-issues.md` COMPLETE-BUILTIN.

### TMUX-ENV-WARN: Add tmux environment warnings on session start
Check for jixiuf/tmux fork (`kitty-keys` option) and warn if not present. Surface as a widget or notification on session_start.

### ATTACH-VERIFY: Verify attach by checking view pane existence
`attach` trusts an in-memory flag without verifying the pane exists. See `docs/engineering/open-issues.md` ATTACH-VERIFY.

## Medium priority

### HOST-MISMATCH: Map Pi's tmux host session and window to the tab Pi is actually running in
The current host detection effectively assumes host window `0`, but manual verification proved Pi was running in a different window inside the same tmux session. Use `TMUX_PANE` as the primary source of truth for Pi's own tmux location, then use `tmux capture-pane` plus `it2api get-buffer` only as external confirmation that the operator-visible tab matches that pane. See `docs/engineering/open-issues.md` HOST-MISMATCH.

### CTX-SIGNAL: Wire ctx.signal for cancellation support
Pi 0.63.2 added `ctx.signal` to extension contexts. Currently `actionRun` ignores the signal parameter. Wire it to kill the staging pane when the user cancels a tool call mid-execution.

### SCHEMA-COMPAT: Use prepareArguments for schema migration
Pi 0.64.0 added `ToolDefinition.prepareArguments` hook. Use it to handle resumed sessions where the tool schema may have changed without breaking old sessions.

### FOCUS-LEAK: Fix focus reporting escape sequence leakage
`^[[I` / `^[[O` appear as raw text in the view pane. See `docs/engineering/open-issues.md` FOCUS-LEAK.

## Low priority

### MSG-DELIVERY: Leverage extension-queued message delivery fix
Pi 0.64.0 fixed extension-queued user messages being dropped during active turns. Verify this works for the silence alert flow.

### HOST-RENAME: Rename host session on startup
Consider renaming the CC host session to a human-readable name. Currently the host session has a tmux auto-assigned numeric name. Low priority since the name is not user-facing in iTerm2 CC mode.
