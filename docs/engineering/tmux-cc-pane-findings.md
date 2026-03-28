# tmux CC pane findings

This note records what we actually tried in iTerm2 tmux CC mode and what we observed to work.

It is not intended to lock in final terminology or architecture. It exists so future work starts from observed behaviour instead of half-remembered guesses.

## Why this note exists

We spent a long session trying to make command panes work inside a single iTerm2 CC tab without tab flash. Several earlier explanations mixed together:

- what tmux officially guarantees
- what iTerm2 appears to do in practice
- local naming used during debugging
- ideas that sounded plausible but later failed

This note separates those.

## Local labels used during debugging

These are working labels, not official tmux terms.

- **CC session**: the tmux session attached to iTerm2 via `tmux -CC`. In our setup this is the session where pi itself runs.
- **view pane**: pane `1` in window `0` of the CC session. This is the visible command area next to pi.
- **non-CC session**: a separate tmux session that is not attached to iTerm2 CC mode.
- **staging session**: our local label for that non-CC session when we use it as the place where command panes are created before being shown in the CC session.
- **CC transmutation workaround**: another local label. It refers to the observed behaviour where a pane created in the non-CC session can later be swapped into the CC session's visible split and then behaves like a native CC pane while it is there.

These names are convenient, but they are just labels for observed behaviour.

## What we know works

### 1. Creating new tmux windows inside the CC session flashes

Observed repeatedly:

- `tmux new-window -d ...` in the CC-attached session triggers iTerm2 tab creation
- hiding that window afterwards with `set-tmux-window-visible --no-visible` is too late to avoid the brief flash
- using the iTerm2 Python API back-to-back did not avoid the flash either

Working conclusion:

- if a new tmux window is born inside the CC-attached session, we should expect a visible tab flash

### 2. Creating a visible split inside the existing CC tab is acceptable

Observed:

- creating pane `1` in window `0` with `split-window` changes the layout inside the current tab
- this is not the same failure mode as `%window-add` tab flash
- this split is the stable viewport for commands

Working conclusion:

- one persistent split inside the CC tab is acceptable
- repeated creation of new CC windows is the thing we want to avoid

### 3. `swap-pane` is the clean switching primitive

Observed repeatedly:

- `break-pane` + `join-pane` caused redraws and visible mess
- resizing or squishing extra panes produced incorrect layouts
- `swap-pane` switched what was visible in the command area cleanly

Working conclusion:

- switching should use `swap-pane`
- we should avoid break/join and pane-resize tricks for this use case

### 4. New windows can be created with no flash in a non-CC session

Observed:

- creating windows in a separate tmux session that is not attached to CC mode causes no iTerm2 tab flash
- commands can start there normally

Working conclusion:

- if we need per-command window isolation without tab flash, create those windows outside the CC-attached session

### 5. A pane born outside CC can be swapped into the CC split and used there

Observed during the breakthrough experiment:

1. create `cmd-A`, `cmd-B`, `cmd-C` in the non-CC session
2. run commands there
3. `swap-pane` one of those panes into the visible command split in the CC session
4. inspect the visible result in iTerm2

Observed result:

- no tab flash during creation
- no tab flash during the swap
- the visible pane in the CC split behaved like a native CC pane while it was visible there
- scrollback behaved like the user expected from a CC pane

This is the key workaround we discovered.

## Best current description of the workaround

The most accurate plain-language description we currently have is:

> Create command panes in a separate non-CC tmux session, then use `swap-pane` to move one into the visible split inside the CC-attached session when it needs to be shown.

A slightly more specific version is:

1. pi runs in the CC-attached tmux session
2. window `0` has pi in pane `0`
3. pane `1` is the stable visible command viewport
4. command windows are created in a separate non-CC tmux session
5. commands start there
6. `swap-pane` moves the chosen pane into the CC viewport
7. another `swap-pane` can move a different pane in later

## Why we called it "CC transmutation"

This was just a debugging nickname.

What we observed was:

- a pane was created in a non-CC session
- once swapped into the visible split of the CC-attached session, it behaved like a CC pane from the user's point of view

We do not need to claim anything stronger than that.

Safer wording:

- the pane is **born outside CC**
- the pane is **displayed inside CC later**
- while displayed there, it behaves like the kind of pane we wanted

## What did not hold up

These ideas were explored and should not be treated as the main solution:

- **break-pane + join-pane** as a clean switch mechanism
- **pane resizing / squishing inactive panes** to fake hiding
- **creating CC windows and immediately hiding them** as a true zero-flash solution
- **pool of pre-created hidden windows** as the preferred design
- **single persistent pane + `respawn-pane`** as a full replacement for isolated command windows

Some of these technically worked in limited ways, but they did not match the required operator experience.

## Practical implications for the extension

The extension should preserve these properties:

- command isolation comes from windows created in the non-CC session
- the visible command area stays as one stable split inside the CC session
- switching uses `swap-pane`
- completion tracking should prefer pane identity over assumptions about window visibility

## Things we still should treat as observations, not laws

We should stay cautious about over-generalising the experiments.

Observed in our setup:

- the visible swapped-in pane behaved like a native CC pane
- scrollback worked as expected
- no flash occurred during cross-session swaps

Not yet something we should state as a hard universal rule:

- exactly how iTerm2 internally models the swapped pane
- whether every tmux/iTerm2 version behaves identically
- whether the pane permanently changes status or only behaves this way while resident in the CC session

## Command shapes we tested

These are representative shapes, not copy-paste prescriptions for all future code.

Create the visible command split once:

```bash
tmux split-window -h -t <cc-session>:0 -d
```

Create a command window outside CC:

```bash
tmux new-window -d -t <non-cc-session> -n <name> -c <cwd>
```

Send the command there:

```bash
tmux send-keys -t <non-cc-session>:<window>.0 "<command>" C-m
```

Swap it into the visible CC split:

```bash
tmux swap-pane -d -s <cc-session>:0.1 -t <non-cc-session>:<window>.0
```

Switch to another one later:

```bash
tmux swap-pane -d -s <cc-session>:0.1 -t <non-cc-session>:<other-window>.0
```

## Short version

If you only remember one thing, remember this:

- creating a new window inside CC flashes
- creating it outside CC does not
- `swap-pane` lets us show that outside-created pane inside the CC split cleanly
- that is the current best-known working mechanism
