# pi-tmux Roadmap

## Planned

### Wire ctx.signal for cancellation support
Pi 0.63.2 added `ctx.signal` to extension contexts. Currently `actionRun` ignores the signal parameter. Wire it to kill the staging pane when the user cancels a tool call mid-execution, so long-running commands don't keep running after cancellation.

### Use prepareArguments for schema migration
Pi 0.64.0 added `ToolDefinition.prepareArguments` hook. Use it to handle resumed sessions where the tool schema may have changed (e.g. parameter renames, new required fields) without breaking old sessions.

### Leverage extension-queued message delivery fix
Pi 0.64.0 fixed extension-queued user messages being dropped during active turns. Silence/completion notifications submitted via `pi.sendUserMessage()` while the agent is running should now reliably deliver. Verify this works for our silence alert flow and consider using it for richer completion notifications.

### Disable non-tmux mode, gate behind /tmux-promote
Non-tmux (legacy) code paths add complexity and are untested in practice. Plan:
- When not in tmux: show widget warning "tmux disabled -- run /tmux-promote", register only the promote command, tool returns error pointing to promote
- When in tmux: full tool available
- Mark `terminal-legacy.ts` as deprecated, keep only for the promote path
- Follow the ACM pattern from pi-context for the disabled/enabled gate

### Add tmux environment warnings on session start
Check for jixiuf/tmux fork (`kitty-keys` option) and warn if not present. Check `extended-keys` and `extended-keys-format` like pi itself does. Surface as a widget or notification on session_start.

### Rename host session on startup
Consider renaming the CC host session to a human-readable name on session_start (e.g. project slug). Currently the host session has a tmux auto-assigned numeric name which is invisible to the operator but shows up in `tmux list-sessions`. Low priority since the name is not user-facing in iTerm2 CC mode.
