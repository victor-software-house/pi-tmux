# pi-tmux Roadmap

## Suggested execution order

1. **PANE-META** — Replace pane metadata with staging window queries. This unblocks list, peek, close, focus, resume, and mute. Every other improvement depends on these actions working correctly.
2. **ATTACH-VERIFY** — Small fix, eliminates a class of confusing "already visible" false positives. Do it while touching the terminal code.
3. **LEGACY-GATE** (phase 1) — Add the runtime gate so the tool stops pretending to work outside tmux. No code deletion, just a check and a warning. This prevents wasted debugging time on a path that will never be supported.
4. **LEGACY-GATE** (phases 2-3) — Delete legacy branches from `actions.ts`, delete `terminal.ts` dispatcher, delete `terminal-legacy.ts`, rename `terminal-tmux.ts` to `terminal.ts`. Easier to do after PANE-META because `actions.ts` will already be heavily edited.
5. **OUTPUT-TRACK** — Implement `tmux pipe-pane` logging and output metadata in completion notifications. Depends on PANE-META because `peek` must resolve panes by name before ranged output reads are useful.
6. **COMPLETE-BUILTIN** — Fix premature completion for shell builtins (`read`, `wait`, etc.). Independent of other items. Lower urgency because most commands the model runs are external processes, not interactive builtins.
7. **HOST-MISMATCH** — Fix host-session to operator-visible-tab mapping before declaring the tmux CC path verified. The split currently appears in a real tmux host session, but not necessarily in the iTerm2 tab Pi is running in. Use the deterministic `TMUX_PANE` + `tmux capture-pane` + `it2api get-buffer` matching check from `docs/engineering/open-issues.md` rather than relying on focus alone.
8. **FOCUS-LEAK** — Cosmetic. Fix after the swap-pane flow is stable.
9. **CTX-SIGNAL, SCHEMA-COMPAT, MSG-DELIVERY** — Integrations with Pi runtime APIs added in v0.63-0.64. Independent of each other and of the above items.

Items 1-2 are prerequisites for everything else. Items 3-5 have ordering dependencies (noted above). Item 7 blocks final confidence in live tmux CC verification. Items 6, 8, and 9 are otherwise independent.

---

## Critical — fix before further feature work

### PANE-META: Replace pane metadata with staging window queries
The `@pi_managed` / `@pi_title` pane metadata system is broken by `swap-pane`. This blocks `list`, `peek` by name, `close`, `focus`, `resume`, and `mute`. The staging session's window names are the correct source of truth. See `docs/engineering/open-issues.md` PANE-META for full details and verification criteria.

### LEGACY-GATE: Disable non-tmux mode, gate behind /tmux-promote
Non-tmux (legacy) code paths add complexity and are untested. Three-phase plan:
1. Gate: runtime check on session_start, widget warning, tool returns error outside tmux
2. Remove: delete legacy branches from actions.ts, delete terminal.ts dispatcher
3. Simplify: direct imports, consider renaming host session on promote
See `docs/engineering/legacy-audit.md` for full audit of what's dead, what survives, and what actively hurts the tmux path.

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

### HOST-MISMATCH: Map Pi's tmux host session to the tab Pi is actually running in
The current host-session detection uses tmux's session name, but live verification showed that this can point at a tmux integration context different from the visible iTerm2 tab containing Pi. Before running visibility-sensitive validation, identify Pi's own tab deterministically by matching `TMUX_PANE` scrollback from `tmux capture-pane` against candidate buffers from `it2api get-buffer`. See `docs/engineering/open-issues.md` HOST-MISMATCH.

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
