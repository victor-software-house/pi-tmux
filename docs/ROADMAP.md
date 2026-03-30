# pi-tmux Roadmap

## Suggested execution order

1. **PANE-META** — Replace pane metadata with staging window queries. This unblocks list, peek, close, focus, resume, and mute. Every other improvement depends on these actions working correctly.
2. **ATTACH-VERIFY** — Small fix, eliminates a class of confusing "already visible" false positives. Do it while touching the terminal code.
3. **LEGACY-GATE** (phase 1) — Add the runtime gate so the tool stops pretending to work outside tmux. No code deletion, just a check and a warning. This prevents wasted debugging time on a path that will never be supported.
4. **LEGACY-GATE** (phases 2-3) — Delete legacy branches from `actions.ts`, delete `terminal.ts` dispatcher, delete `terminal-legacy.ts`, rename `terminal-tmux.ts` to `terminal.ts`. Include **HOST-PLUMBING** refactor: replace positional `hostSession` + `hostWindowIndex` threading with a single `HostTarget` object. Easier to do after PANE-META because `actions.ts` will already be heavily edited.
5. **OUTPUT-TRACK** — Implement `tmux pipe-pane` logging and output metadata in completion notifications. Depends on PANE-META because `peek` must resolve panes by name before ranged output reads are useful.
6. **COMPLETE-BUILTIN** — Fix premature completion for shell builtins (`read`, `wait`, etc.). Independent of other items. Lower urgency because most commands the model runs are external processes, not interactive builtins.
7. **HOST-MISMATCH** — Fix host-session to operator-visible-tab mapping before declaring the tmux CC path verified. The split currently appears in a real tmux host session, but not necessarily in the iTerm2 tab Pi is running in. Use the deterministic `TMUX_PANE` + `tmux capture-pane` + `it2api get-buffer` matching check from `docs/engineering/open-issues.md` rather than relying on focus alone.
8. **FOCUS-LEAK** — Done. Fixed by clearing pane focus reporting after every `swap-pane` into the visible host view pane.
9. **CTX-SIGNAL, SCHEMA-COMPAT, MSG-DELIVERY** — Integrations with Pi runtime APIs added in v0.63-0.64. Independent of each other and of the above items.

Items 1-8 are done except item 9 MSG-DELIVERY. **SWAP-SHUFFLE** (not numbered above — emerged after PANE-META) is also done: `@pi_name` pane-label identity replaced the `@pi_staging_index` two-swap workaround.

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

## Critical — fix before further feature work (all done)

### ~~PANE-META~~ (done)
Replaced pane-option metadata with staging-window-based inventory. Then further evolved into `@pi_name` pane-label identity via SWAP-SHUFFLE fix.

### ~~ATTACH-VERIFY~~ (done)
View pane existence verified via tmux query before reporting attached.

### ~~LEGACY-GATE~~ (done)
All three phases complete. HostTarget object replaces positional host args. Dead code removed.

Remaining from the original plan: `terminal-tmux.ts` has not been renamed to `terminal.ts` — this would break test imports and is deferred.

### ~~SWAP-SHUFFLE~~ (done)
Replaced `@pi_staging_index` two-swap return-address pattern with `@pi_name` single-swap pane-label identity. `listManagedPanes` discovers panes by `@pi_name` across staging + view. Single `swap-pane` by pane ID.

## High priority

### ~~OUTPUT-TRACK~~ (done)
Completion notifications and peek now report truncation metadata (`N lines total, showing last M`). Full scrollback captured via `capture-pane -S -`. Peek accepts a `limit` parameter.

### ~~COMPLETE-BUILTIN~~ (done)
Completion tracker now requires `seenNonShell` before firing. Builtins rely on `silenceTimeout` instead.

### ~~TMUX-ENV-WARN~~ (done)
`checkTmuxEnvironment()` wired into session_start. Warns about missing kitty-keys and extended-keys.

### ~~ATTACH-VERIFY~~ (done)
See Critical section above.

## Medium priority

### ~~HOST-MISMATCH~~ (done)
Host window detected from `TMUX_PANE` at startup, threaded through all view pane operations via `HostTarget`.

### ~~CTX-SIGNAL~~ (done)
Abort signal wired to send C-c and stop completion tracking on cancellation.

### ~~SCHEMA-COMPAT~~ (done)
`prepareArguments` uses TypeBox `Value.Cast` to coerce legacy argument shapes into the current schema.

### ~~FOCUS-LEAK~~ (fixed)
Root cause: the shell enables focus reporting (`\e[?1004h`), which sets pane mode `MODE_FOCUSON`; tmux then forwards focus-in/out as `\e[I` / `\e[O` to the visible pane. Fixed by writing `\e[?1004l` to the pane pty slave after every `swap-pane` into the visible host view pane. Verified 2026-03-30 with three long-running panes, repeated `focus` swaps, operator click-in/click-out on each visible pane, and clean `peek all` output.

## Low priority

### LIST-ATTACHED (done)
`actionList()` now queries `hasAttachedPane(host.session, host.windowIndex)` and reports the real state in both the header and `details.attached`, so `tmux list` shows `(detached)` when the host view pane is gone.

### MSG-DELIVERY: Leverage extension-queued message delivery fix
Pi 0.64.0 fixed extension-queued user messages being dropped during active turns. Verify this works for the silence alert flow.

### HOST-RENAME: Rename host session on startup
Consider renaming the CC host session to a human-readable name. Currently the host session has a tmux auto-assigned numeric name. Low priority since the name is not user-facing in iTerm2 CC mode.
