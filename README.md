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

## Recommended tmux setup

Pi uses modified key sequences (Ctrl+Shift+P, Ctrl+Enter, etc.) that stock tmux cannot forward correctly. The recommended setup uses the [jixiuf/tmux](https://github.com/jixiuf/tmux) fork, which adds the Kitty keyboard protocol.

### Install the tmux fork

```bash
# Build from source (macOS)
brew install libevent ncurses utf8proc autoconf automake pkg-config
git clone https://github.com/jixiuf/tmux.git /tmp/jixiuf-tmux
cd /tmp/jixiuf-tmux
sh autogen.sh
PKG_CONFIG_PATH="/opt/homebrew/opt/ncurses/lib/pkgconfig:/opt/homebrew/lib/pkgconfig" \
  LDFLAGS="-L/opt/homebrew/lib" \
  ./configure --prefix=/usr/local --enable-utf8proc
make -j$(sysctl -n hw.logicalcpu)
brew unlink tmux
sudo cp tmux /usr/local/bin/tmux
```

Verify: `tmux -V` should show `next-3.7`.

### ~/.tmux.conf

```tmux
# Kitty keyboard protocol (jixiuf/tmux fork)
set -s kitty-keys on
set -as terminal-features '*:kitkeys'

# Extended keys fallback
set -g extended-keys on
set -g extended-keys-format csi-u
set -as terminal-features 'xterm*:extkeys'
set -as terminal-features 'tmux*:extkeys'

# Mouse
set -g mouse on

# Truecolor and undercurl
set -g default-terminal "tmux-256color"
set -as terminal-features ',xterm-256color:RGB'
set -as terminal-features ',xterm-256color:usstyle'

# Fast escape
set -g escape-time 10

# Focus events
set -g focus-events on

# Clipboard via OSC 52
set -g set-clipboard on

# Allow passthrough (shell integration, imgcat)
set -g allow-passthrough on

# Scrollback
set -g history-limit 50000

# Renumber windows on close
set -g renumber-windows on
```

### iTerm2 settings

If using iTerm2 with `tmux -CC` integration:

1. Create a profile named `tmux` and configure it (colors, font, etc.)
2. Enable **Settings > General > tmux > Use `tmux` profile rather than profile of connecting session**

### Why not stock tmux?

Stock tmux supports `extended-keys` with CSI-u encoding, but `extended-keys always` breaks Ctrl-C in regular shells. The `on` mode (apps opt-in) is safe but pi does not explicitly request extended keys, so modified keys are not forwarded.

The jixiuf fork adds `kitty-keys`, which handles the full Kitty keyboard protocol and correctly forwards Ctrl+Shift+P, Ctrl+Enter, and other modified keys without breaking Ctrl-C.

## Credits

Original: [@romansix/pi-tmux](https://github.com/indigoviolet/pi-tmux) by [indigoviolet](https://github.com/indigoviolet).
Inspired by [normful/picadillo's run-in-tmux skill](https://github.com/normful/picadillo/blob/main/skills/run-in-tmux/SKILL.md).

## License

Apache 2.0
