# pi-tmux execution plan

This file expands `docs/ROADMAP.md` into an implementation sequence with concrete code slices, validation steps, and documentation follow-up.

If this file conflicts with older exploratory notes, follow these files in this order:

1. `docs/ROADMAP.md`
2. `docs/engineering/open-issues.md`
3. `docs/engineering/legacy-audit.md`
4. `PLAN.md`

## Current status

The core tmux CC mechanism is in place:

- commands are created in the hidden staging session
- the operator sees one stable view pane in the CC-attached host session
- `swap-pane` rotates staging panes into the visible split

The remaining work is not about inventing a new architecture. It is about making the current architecture reliable, observable, and simpler to maintain.

## Execution order

| Order | Issue | Why now | Main files |
|---|---|---|---|
| 1 | `PANE-META` | Unblocks naming, focus, peek, close, resume, mute, clear | `extensions/session.ts`, `extensions/actions.ts`, `extensions/command.ts`, `test/actions.test.ts` |
| 2 | `ATTACH-VERIFY` | Small fix in the same area as pane/view handling | `extensions/terminal-tmux.ts`, `extensions/actions.ts`, `test/actions.test.ts` |
| 3 | `LEGACY-GATE` phase 1 | Stops unsupported non-tmux usage from pretending to work | `extensions/index.ts`, `extensions/actions.ts`, `extensions/terminal.ts`, `README.md`, docs |
| 4 | `LEGACY-GATE` phases 2-3 | Deletes dead branches after tmux path is trustworthy | `extensions/actions.ts`, `extensions/terminal.ts`, `extensions/terminal-legacy.ts`, `extensions/promote.ts`, `extensions/types.ts`, tests |
| 5 | `OUTPUT-TRACK` | Gives the model enough output context to act safely | `extensions/signals.ts`, `extensions/session.ts`, tool schema, tests |
| 6 | `COMPLETE-BUILTIN` | Fixes false completion for interactive shell builtins | `extensions/signals.ts`, `extensions/session.ts`, tests |
| 7 | `FOCUS-LEAK` | Removes visible output corruption after swap | `extensions/session.ts` or swap helper path, live validation |
| 8 | `CTX-SIGNAL` | Adds cancellation support to tool execution | `extensions/index.ts`, `extensions/actions.ts`, `extensions/signals.ts` |
| 9 | `SCHEMA-COMPAT` | Prevents resumed sessions from breaking across tool schema changes | tool registration path |
| 10 | `MSG-DELIVERY` | Verify new runtime behavior, then adopt if useful | integration-level verification |

## Phase 1: make pane addressing correct

### 1. `PANE-META`

### Goal

Replace pane-option metadata with staging-window queries so names and indices remain stable after `swap-pane`.

### Implementation slices

#### Slice 1A: introduce staging-window inventory

Add a staging-window-based inventory layer in `extensions/session.ts`.

Planned work:

- add a function that lists staging windows with:
  - `window_index`
  - `window_name`
  - current `pane_id`
  - `pane_current_command`
  - `pane_pid`
- derive `visible` by comparing the staging window's current pane with the host view pane swap result, not by trusting pane metadata
- derive `idle` from command + child-process check using the current pane in that staging slot
- stop reading `@pi_managed`, `@pi_title`, and `@pi_owner_session` for tmux-mode pane discovery

Expected outcome:

- the authoritative object becomes "staging window record"
- pane IDs become transient runtime properties, not identity

#### Slice 1B: replace action resolution paths

Update tmux-mode actions in `extensions/actions.ts` to resolve against staging windows.

Planned work:

- `actionRun`
  - reuse idle staging windows by window name/index from the staging inventory
  - on respawn, rename the staging window and then resolve its current pane ID from tmux
  - on resume, resolve the target by staging window identity, then send keys to that window's current pane
- `actionFocus`
  - resolve by staging window name/index
  - swap by staging window index
- `actionPeek`
  - capture output from the current pane occupying the target staging window
- `actionClose`
  - kill the pane or window for the resolved staging slot only
- `actionList`
  - print stable names and staging indices
- `actionMute`
  - resolve the staging window first, then clear silence by that resolved window index
- `actionClear`
  - clear only tmux-mode idle staging windows
  - do not fall through to legacy logic

#### Slice 1C: remove stale metadata writes

Once tmux-mode actions no longer depend on pane options:

- delete `markManagedPane()` calls from the tmux path if no longer needed
- delete `setManagedPaneTitle()` calls from the tmux path if no longer needed
- remove or reduce dead metadata helpers in `extensions/session.ts`

Do this only after the new inventory path is fully in place.

### Validation

#### Automated

Add or update tests for:

- three named runs: `a`, `b`, `c`
- focus by name after multiple swaps
- peek by name after multiple swaps
- close by name only removing the requested command
- resume by name targeting the correct current pane
- clear operating only on tmux-mode idle staging windows

#### Live tmux CC

Run this exact sequence with operator confirmation:

1. `run name: "a"`
2. `run name: "b"`
3. `run name: "c"`
4. `focus window: "a"`
5. `peek window: "b"`
6. `close window: "c"`
7. `list`
8. `run shellMode: "resume" window: "a"`

Done means the names remain correct through the whole sequence.

### Exit criteria

`PANE-META` is done when tmux-mode actions no longer rely on pane user options for identity and the open-issues verification sequence passes.

---

### 2. `ATTACH-VERIFY`

### Goal

Make `attach` verify the view pane exists in tmux before reporting success.

### Implementation

In `extensions/terminal-tmux.ts`:

- replace the current `viewPaneId` trust check with a tmux query against host session window `0`
- verify pane index `1` exists before returning "already visible"
- if pane index `1` is missing:
  - clear `viewPaneId`
  - create a new split with `split-window`
  - store the new pane ID

In `extensions/actions.ts`:

- keep `actionAttach()` small
- let the terminal helper be the source of truth for whether the visible pane exists

### Validation

#### Automated

Add a test where:

- `hasAttachedPane()` or the terminal helper initially thinks the pane exists
- tmux query shows pane `1` does not exist
- `openTerminal()` recreates the split instead of returning early

#### Live tmux CC

1. create the visible split
2. manually close the split in iTerm2
3. run `attach`
4. confirm the split is recreated

### Exit criteria

`attach` never reports success without an actual pane `1` present in the host session.

## Phase 2: stop supporting the wrong runtime

### 3. `LEGACY-GATE` phase 1

### Goal

Make tmux CC the only supported runtime and fail clearly outside tmux.

### Implementation

#### Session start behavior

In `extensions/index.ts`:

- on `session_start`, detect `!process.env.TMUX`
- show a warning widget or notification explaining:
  - pi-tmux requires tmux CC mode
  - `/tmux-promote` is the supported entry path from a regular terminal
- keep `/tmux-promote`
- gate the tool so normal actions return a clear error outside tmux

#### Tool behavior

- `run`, `attach`, `focus`, `close`, `peek`, `list`, `kill`, `mute`, `clear` should return one consistent unsupported-runtime error outside tmux
- the message should tell the operator to use `/tmux-promote`

### Validation

- start Pi outside tmux
- confirm the warning is shown once per session start
- confirm the tool refuses normal actions with the same clear message
- confirm `/tmux-promote` still works

### Exit criteria

The extension no longer pretends non-tmux mode is supported.

---

### 4. `LEGACY-GATE` phases 2-3

### Goal

Delete the dead legacy branches after tmux-only gating is in place.

### Implementation slices

#### Slice 4A: remove legacy branches

- delete non-tmux branches in `extensions/actions.ts`
- make tmux assumptions explicit instead of checking `process.env.TMUX` inside every action
- remove legacy fallthrough in `actionClear`

#### Slice 4B: collapse terminal implementation

- delete `extensions/terminal.ts` dispatcher
- rename `extensions/terminal-tmux.ts` to `extensions/terminal.ts`
- delete `extensions/terminal-legacy.ts`
- move `getActiveiTermSession()` into `extensions/promote.ts` if still needed there

#### Slice 4C: clean types and tests

- remove `AttachOptions.piSessionId` and any legacy-only types
- remove legacy tests
- add tmux-only tests where coverage is missing
- update README and docs to describe tmux-only architecture accurately

### Validation

- `npm run typecheck`
- `bun test`
- smoke test: run, attach, focus, peek, list, close, kill in tmux CC
- smoke test: `/tmux-promote` still handles outside-tmux entry

### Exit criteria

There is one terminal implementation, one runtime model, and no legacy branches in action logic.

## Phase 3: make output and completion trustworthy

### 5. `OUTPUT-TRACK`

### Goal

Track per-command output precisely and tell the model what was omitted from completion notifications.

### Implementation

#### Slice 5A: add log-backed output capture

Add pipe-pane-backed output logging.

Planned work:

- assign each managed staging window a log file path
- enable `tmux pipe-pane` so pane output is appended continuously
- before sending a command, record the current byte offset in that log file
- on completion, read from the recorded offset to get only the output for that command

#### Slice 5B: enrich completion notifications

Update `extensions/signals.ts`:

- compute total output lines for the completed command
- include metadata such as:
  - total lines
  - lines shown
  - lines omitted
- keep the visible excerpt short, but make truncation explicit

#### Slice 5C: extend peek semantics

- add range support for `peek`
- allow reading a specific line window or tail window from the tracked command output
- ensure the operator and model can fetch omitted sections without rerunning the command

### Validation

- run a command that prints 200 lines
- completion message states total vs shown lines
- `peek` can retrieve an earlier range from the same command output
- output remains correct after pane resize, `clear`, and scrollback pressure

### Exit criteria

Completion notifications are explicit about truncation, and `peek` can recover omitted sections.

---

### 6. `COMPLETE-BUILTIN`

### Goal

Do not mark shell builtins complete while the shell is still blocked inside them.

### Implementation

This likely depends on the new output/logging foundation from `OUTPUT-TRACK`.

Planned investigation order:

1. detect prompt boundaries from shell integration markers if available
2. if prompt markers are not available, detect prompt reappearance from log output
3. only fall back to current-command polling for external processes

Expected tracker split:

- external process path: current process exits
- shell builtin path: shell prompt returns

### Validation

- run `read -r X` with `silenceTimeout: 10`
- verify completion does not fire immediately
- verify silence notification fires after 10 seconds
- verify completion fires only after the operator satisfies the prompt and the shell prompt returns

### Exit criteria

Builtins and prompt-waiting commands no longer produce false completion.

---

### 7. `FOCUS-LEAK`

### Goal

Suppress focus-event escape sequences in the visible pane after swap.

### Implementation

Add the focus-event reset to the swap path.

Planned work:

- after every successful `swap-pane` into the visible pane, send `\e[?1004l`
- keep the fix in the one helper path used by both `run` auto-show and explicit `focus`

### Validation

- run `sleep 999`
- click in and out of the visible pane repeatedly
- verify no `^[[I` or `^[[O` sequences appear
- verify normal interactive apps still behave acceptably

### Exit criteria

The visible pane no longer leaks focus escape sequences into command output.

## Phase 4: runtime compatibility and polish

### 8. `CTX-SIGNAL`

### Goal

Cancel active tmux work when the user cancels the tool call.

### Implementation

- wire the tool execution signal into `actionRun()` and/or the completion tracker path
- on cancellation, kill the active pane or command in the staging window
- ensure cancellation does not kill unrelated panes

### Validation

- start a long-running command
- cancel the tool call mid-turn
- verify the target pane or command is terminated
- verify other panes remain untouched

---

### 9. `SCHEMA-COMPAT`

### Goal

Keep resumed sessions working even if the tmux tool schema changes.

### Implementation

- use `prepareArguments` in the tool registration path
- normalize legacy argument shapes to the current schema before execution
- document any compatibility shims added

### Validation

- simulate older argument payloads where possible
- confirm current execution path still receives normalized arguments

---

### 10. `MSG-DELIVERY`

### Goal

Verify whether Pi 0.66.0 already fixes the extension-queued message loss that affected silence notifications.

### Implementation

- test the current runtime without code changes first
- if the runtime fix is sufficient, remove any now-unnecessary workaround logic
- if not sufficient, document the remaining gap precisely before changing code

### Validation

- run a command that triggers silence notifications during an active turn
- verify the notification reaches the user reliably

## Suggested commit slices

Keep changes small and verifiable.

1. `PANE-META` inventory helpers
2. `PANE-META` action rewrites
3. `PANE-META` tests + live verification
4. `ATTACH-VERIFY`
5. `LEGACY-GATE` phase 1
6. `LEGACY-GATE` deletion pass
7. `OUTPUT-TRACK` logging foundation
8. `OUTPUT-TRACK` notification + peek ranges
9. `COMPLETE-BUILTIN`
10. `FOCUS-LEAK`
11. `CTX-SIGNAL`
12. `SCHEMA-COMPAT`
13. `MSG-DELIVERY` verification and cleanup

## Definition of done for every slice

Before each commit:

- `npm run typecheck`
- `bun test`
- live tmux CC verification for the behavior changed in that slice
- update docs touched by the change in the same session

Documentation follow-up per issue:

- `docs/engineering/open-issues.md` — update root cause or verification notes when the issue changes state
- `docs/ROADMAP.md` — mark sequencing or priority changes
- `README.md` — update operator-facing behavior when tool semantics change
- `AGENTS.md` — update only if design tenets or working practices change

## Immediate next step

Start with `PANE-META`, not cleanup.

The next coding session should begin by replacing pane metadata discovery in `extensions/session.ts`, then rewriting tmux-mode action resolution in `extensions/actions.ts`, then proving the full multi-pane name-based verification sequence live.
