# pi-tmux Roadmap

## Suggested execution order

1. **PANE-META** — Replace pane metadata with staging window queries. This unblocks list, peek, close, focus, resume, and mute. Every other improvement depends on these actions working correctly.
2. **ATTACH-VERIFY** — Small fix, eliminates a class of confusing "already visible" false positives. Do it while touching the terminal code.
3. **Legacy gate** (phase 1) — Add the runtime gate so the tool stops pretending to work outside tmux. No code deletion, just a check and a warning. This prevents wasted debugging time on a path that will never be supported.
4. **Legacy removal** (phases 2-3) — Delete dead code, flatten the branching, rename files. Do this after the gate has been live for a bit. Easier to do once PANE-META is fixed because actions.ts will already be heavily edited.
5. **OUTPUT-TRACK** — Implement pipe-pane logging and output metadata. Depends on PANE-META being done (peek must work by name first). This changes how the model interacts with command output, so it needs stable pane identity.
6. **COMPLETE-BUILTIN** — Fix premature completion for builtins. Independent of other work but lower urgency — most commands are not interactive builtins.
7. **FOCUS-LEAK** — Cosmetic. Fix after the swap-pane flow is stable.
8. **ctx.signal, prepareArguments, message delivery** — Pi API integrations. Do when convenient.

Items within the same priority tier can be reordered. Items across tiers should not — each tier assumes the previous one is done.

---

## Critical — fix before further feature work

### Replace pane metadata with staging window queries
The `@pi_managed` / `@pi_title` pane metadata system is broken by `swap-pane`. This blocks `list`, `peek` by name, `close`, `focus`, `resume`, and `mute`. The staging session's window names are the correct source of truth. See `docs/engineering/open-issues.md` PANE-META for full details and verification criteria.

### Disable non-tmux mode, gate behind /tmux-promote
Non-tmux (legacy) code paths add complexity and are untested. Three-phase plan:
1. Gate: runtime check on session_start, widget warning, tool returns error outside tmux
2. Remove: delete legacy branches from actions.ts, delete terminal.ts dispatcher
3. Simplify: direct imports, consider renaming host session on promote
See `docs/engineering/legacy-audit.md` for full audit of what's dead, what survives, and what actively hurts the tmux path.

## High priority

### Output tracking via pipe-pane
Completion notifications silently truncate to 20 lines with no indication of what was omitted. The model cannot make informed decisions about when to peek. Implement `tmux pipe-pane` to per-pane log files, track byte offsets per command, and include omission metadata in notifications. See `docs/engineering/open-issues.md` OUTPUT-TRACK.

### Fix completion tracker for shell builtins
Builtins like `read` and `wait` cause premature completion because `pane_current_command` stays as the shell name. The model reports commands done before the operator has interacted. See `docs/engineering/open-issues.md` COMPLETE-BUILTIN.

### Add tmux environment warnings on session start
Check for jixiuf/tmux fork (`kitty-keys` option) and warn if not present. Surface as a widget or notification on session_start.

### Verify attach by checking view pane existence
`attach` trusts an in-memory flag without verifying the pane exists. See `docs/engineering/open-issues.md` ATTACH-VERIFY.

## Medium priority

### Wire ctx.signal for cancellation support
Pi 0.63.2 added `ctx.signal` to extension contexts. Currently `actionRun` ignores the signal parameter. Wire it to kill the staging pane when the user cancels a tool call mid-execution.

### Use prepareArguments for schema migration
Pi 0.64.0 added `ToolDefinition.prepareArguments` hook. Use it to handle resumed sessions where the tool schema may have changed without breaking old sessions.

### Fix focus reporting escape sequence leakage
`^[[I` / `^[[O` appear as raw text in the view pane. See `docs/engineering/open-issues.md` FOCUS-LEAK.

## Low priority

### Leverage extension-queued message delivery fix
Pi 0.64.0 fixed extension-queued user messages being dropped during active turns. Verify this works for the silence alert flow.

### Rename host session on startup
Consider renaming the CC host session to a human-readable name. Currently the host session has a tmux auto-assigned numeric name. Low priority since the name is not user-facing in iTerm2 CC mode.
