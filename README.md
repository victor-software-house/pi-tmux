# pi-tmux

A [pi](https://github.com/badlogic/pi) coding agent extension that manages a tmux session per project (one per git root).

Fork of [@romansix/pi-tmux](https://github.com/indigoviolet/pi-tmux) with split pane support for iTerm2.

For the current working notes on iTerm2 tmux CC mode, pane swapping, and the non-CC session workaround, see [`docs/engineering/tmux-cc-pane-findings.md`](docs/engineering/tmux-cc-pane-findings.md).

## Install

```bash
pi install git:github.com/victor-software-house/pi-tmux
```

Or try without installing:

```bash
pi -e git:github.com/victor-software-house/pi-tmux
```

## Features

### `tmux` tool

Provides a `tmux` tool for the agent with these actions:

- **run** -- Run a command in a new tmux window. When the command finishes, the agent is automatically notified with the exit code and recent output, so it doesn't need to wait around.
- **attach** -- Open a terminal view attached to the session. Supports iTerm2, Terminal.app, kitty, ghostty, WezTerm, and tmux nesting. Use `mode` param to control layout: `tab` (default), `split-vertical`, or `split-horizontal`. Splits open inside the current iTerm2 pane.
- **peek** -- Capture recent output from tmux windows. Use `window` to target a specific window, or omit for all.
- **list** -- List all windows in the session.
- **kill** -- Kill the entire session.
- **mute** -- Suppress silence notifications for a window. Use when a command is expected to have long silence periods, not waiting for input.

Commands run in a wrapper script for exit-code tracking and silence detection.

### Silence detection

When running commands that might prompt for input (installers, interactive tools, confirmations), the agent can set `silenceTimeout` to be notified when the command goes quiet.

| Parameter | Description | Default |
|---|---|---|
| `silenceTimeout` | Initial seconds of silence before notifying. 0 or omitted to disable. | -- |
| `silenceBackoffFactor` | Multiply the interval after each notification. | 1.5 |
| `silenceBackoffCap` | Max silence interval in seconds. | 300 (5 min) |

The notification includes a peek of the window output so the agent can decide whether to act or mute the window.

### Commands

- `/tmux` -- Open a terminal tab attached to the project's tmux session
- `/tmux split-vertical` -- Open as a vertical split pane in the current iTerm2 session
- `/tmux split-horizontal` -- Open as a horizontal split pane
- `/tmux:cat` -- Select a tmux window and bring its output into the conversation
- `/tmux:clear` -- Kill idle tmux windows (shells with no running child processes)

### Changes from upstream

- `attach` action supports `mode` parameter: `tab` (default), `split-vertical`, `split-horizontal`
- `/tmux` command accepts mode argument with autocomplete
- iTerm2 AppleScript uses `split vertically` / `split horizontally` on `current session` for split modes

## Credits

Original: [@romansix/pi-tmux](https://github.com/indigoviolet/pi-tmux) by [indigoviolet](https://github.com/indigoviolet).
Inspired by [normful/picadillo's run-in-tmux skill](https://github.com/normful/picadillo/blob/main/skills/run-in-tmux/SKILL.md).

## License

Apache 2.0
