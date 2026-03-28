# tmux CC implementation plan

This plan reflects the current codebase and the latest manual experiments.

It is intentionally directional rather than overly specific. The goal is to preserve the working mechanism we validated while correcting the places where the current code still assumes an older model.

## Current state

## What is already working

The current implementation already contains the core workaround that proved valid in manual testing:

- command windows can be created in a separate non-CC tmux session
- the CC-attached session keeps one visible split as the command viewport
- `swap-pane` can move a pane from the non-CC session into the visible CC split without the tab-flash caused by creating new CC windows
- completion tracking in tmux mode already moved toward pane-based tracking via pane ID

This is the right foundation and should be preserved.

## What the current code still gets wrong or models too loosely

### 1. The runtime model is still too window-centric

The experiments showed that pane identity is the durable object, not the staging window slot.

After swaps:

- a pane can move between sessions
- the staging window slot can end up holding a different pane than before
- window names can keep referring to old intent even though a different pane is now parked there

That means the current code still has an important mismatch:

- several actions still treat staging window index or window name as the stable identity of a command
- the experiments showed that this is not a reliable assumption

### 2. Fresh-shell and resume-existing-shell behaviour are not explicitly modeled

In tmux mode, reuse currently implies `respawn-pane -k`, which gives a fresh process path, but the agent has no explicit control over:

- running in a fresh shell
- resuming in an existing shell state
- merely focusing an already running pane

This makes the lifecycle ambiguous for the agent.

### 3. Reused-pane command dispatch needs readiness handling

Manual experiments showed that sending to a reused pane too early after `respawn-pane -k` can hit an in-between shell startup state and produce visible junk.

The current code does not yet have a readiness gate for this path.

### 4. Agent-facing semantics are not yet explicit enough

The tool responses and control surface do not yet clearly expose:

- whether a pane was freshly created or reused
- whether the shell is fresh or resumed
- whether a pane was merely swapped into view or actually restarted
- whether a pane is visible now or parked offscreen

This makes reasoning harder for the agent than it needs to be.

### 5. User policy and agent intent are not cleanly separated yet

We want a compact control surface, but we also want user-level customization.

Examples:

- whether dispatch should auto-show the pane
- whether auto-focus should happen on run
- how aggressive reuse should be

The current settings surface comes from the earlier window-based model and is not yet aligned with the pane-based lifecycle.

### 6. Introspection actions still need to align with the new model

`list`, `focus`, `peek`, `close`, and related behaviour should describe or operate on the thing the user and agent actually care about.

Right now, some of those actions still inherit assumptions from the earlier window-per-command design.

### 7. Automated coverage is behind the architecture

Current tests mostly cover the non-tmux legacy path.

The tmux mode now needs dedicated coverage for:

- non-CC creation + CC swap flow
- pane identity tracking
- readiness handling on reused panes
- lifecycle semantics for visible/offscreen/fresh/reused behaviour

## Implementation steps

### Step 1: Preserve and formalize the pane lifecycle that already works

Keep the current proven foundation:

- commands are born in a separate non-CC tmux session
- one stable split in the CC session acts as the visible viewport
- switching uses `swap-pane`

Treat this as the non-negotiable base, not as an experiment.

### Step 2: Move the tmux-mode runtime model from windows to pane-centric records

Introduce a clearer logical model for tmux mode where the important identity is the pane, not the staging window slot.

The design direction should make it possible to reason about:

- pane identity
- current location
- visible vs offscreen state
- idle vs running state
- fresh vs reused shell state

### Step 3: Separate shell continuity from visibility

The implementation should explicitly distinguish:

- **fresh shell** execution
- **resume existing shell** execution
- **show/focus** behaviour

These should not be conflated into one implicit reuse rule.

The agent must be able to choose the execution continuity it needs, while user policy can still influence what gets shown automatically.

### Step 4: Add a bounded shell-readiness gate for reused panes

When a pane is reused via `respawn-pane -k`, dispatch should wait for a short bounded readiness condition instead of relying on a fixed sleep.

The current design direction is:

- use generic pane-state quiescence rather than prompt glyph matching
- keep the wait bounded and short
- prefer a generic baseline that works across shell setups

### Step 5: Redesign the agent-facing semantics without exploding the command surface

Keep the surface compact, but make intent clearer.

The guiding direction is:

- fewer high-level actions
- richer options or settings where needed
- responses that explicitly say whether the action created, reused, resumed, or merely focused a pane

The goal is better reasoning, not more verbs.

### Step 6: Revisit settings so user policy and runtime mechanics are cleanly separated

Settings should describe stable operator policy rather than accidental implementation details.

Examples of policy areas:

- auto-show or auto-focus on dispatch
- default preference for fresh vs resumed shell behaviour when the agent does not specify
- reuse policy at a high level

The exact names can evolve, but the distinction between policy and per-run intent should become clearer.

### Step 7: Align introspection and lifecycle actions with the pane model

Update list, focus, peek, close, clear, and related behaviour so they report and act on meaningful pane lifecycle state rather than stale window assumptions.

The output should help both the agent and the operator understand what is actually alive, visible, reusable, or running.

### Step 8: Add tmux-mode validation at two levels

Add both:

- automated tests for the pane-centric control flow
- repeatable manual UX checks for the visible behaviour inside iTerm2 CC mode

Acceptance should include:

- zero-flash switching
- correct offscreen execution
- clean reused-pane dispatch
- understandable agent-visible lifecycle messages

## Short priority order

If implementation needs to be phased, the recommended order is:

1. preserve the proven non-CC creation + CC swap mechanism
2. introduce pane-centric runtime records
3. add bounded readiness handling for reused panes
4. expose fresh/resume/show semantics cleanly
5. align settings and user policy
6. expand tests and UX validation

## Immediate code sequence

This is the recommended implementation order in the current codebase.

### Phase 1: Introduce pane-centric metadata and lookup primitives

Primary files:

- `extensions/session.ts`
- `extensions/types.ts`

Immediate goals:

- add tmux-mode helpers that identify managed panes directly rather than by staging window index
- add pane query helpers for:
  - pane ID
  - current session/window/pane location
  - running vs idle state
  - visible-in-CC vs parked-offscreen state
- add a small pane metadata layer so a managed command keeps its logical identity even after swaps

Likely direction:

- store per-pane metadata using tmux pane user options such as `@pi_*`
- query managed panes by pane ID and metadata rather than trusting window name or window slot

This phase fixes the main architectural mismatch without changing the visible command surface yet.

### Phase 2: Rebuild tmux-mode `run` around pane identity

Primary file:

- `extensions/actions.ts`

Immediate goals:

- keep the existing non-CC creation + CC swap architecture
- change tmux-mode reuse selection to operate on managed panes, not on staging window names alone
- make the tmux-mode `run` result explicitly report whether it:
  - created a fresh pane
  - respawned a reusable pane for a fresh shell
  - resumed an existing shell
  - swapped an already running pane into view

Important constraint:

- do not regress the zero-flash path that already works

### Phase 3: Add shell-continuity semantics to the main action model

Primary files:

- `extensions/types.ts`
- `extensions/settings.ts`
- `extensions/tool-builder.ts`
- `extensions/index.ts`
- `extensions/command.ts`

Immediate goals:

- introduce a compact way for the agent to express shell intent on `run`
- keep this as part of a compact high-level API instead of splitting into many tiny commands
- keep user policy separate from agent intent

Current design direction:

- `run` gets an explicit shell continuity choice such as fresh vs resume
- settings provide the default policy when the agent does not specify one
- display policy such as auto-show/auto-focus remains user-configurable

### Phase 4: Add bounded readiness handling for reused fresh-shell panes

Primary files:

- `extensions/session.ts`
- `extensions/actions.ts`

Immediate goals:

- after `respawn-pane -k`, wait for a short bounded quiescence condition before sending the command
- use generic pane-state stability instead of prompt glyph matching
- keep the wait short and bounded

Implementation note:

- this phase may justify making the tmux-mode `run` path async if that produces a cleaner wait implementation than a blocking polling loop

### Phase 5: Re-audit lifecycle actions against the pane model

Primary files:

- `extensions/actions.ts`
- `extensions/session.ts`
- `extensions/index.ts`

Immediate goals:

- make `list` describe managed panes, not just staging windows
- make `focus` target the intended pane identity
- make `peek` capture the intended pane output regardless of current parking slot
- make `close`, `clear`, and `mute` operate on meaningful managed-pane targets

This is where the user and agent mental model must become obviously correct.

### Phase 6: Update tests to match tmux-first behaviour

Primary files:

- `test/actions.test.ts`
- `test/session.test.ts`
- possibly new tmux-mode-specific test files

Immediate goals:

- add tmux-mode tests for pane-centric selection and reporting
- cover fresh vs resume semantics
- cover readiness-gated reuse
- cover list/focus/peek/close behaviour after pane swaps

### Phase 7: Do another manual UX validation pass

Primary targets:

- current repo
- at least one other repo with a different shell startup profile

Immediate goals:

- verify zero-flash switching still holds
- verify reused-pane dispatch looks clean
- verify agent-visible messages accurately describe what happened
