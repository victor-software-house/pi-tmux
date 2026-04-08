# pi-tmux Roadmap

## Vision

pi-tmux enables agents to manipulate live interactive terminals — running commands in the background, observing output as diffs, responding to prompts, and sharing terminal state across agents. The operator sees what the agent does; the agent sees what it cannot see.

The current architecture uses tmux CC mode with a staging/host session split. It relies on polling (`pane_current_command` checks, `capture-pane` reads, silence timers) which is inherently fragile and wasteful.

The next phase moves to an **event-driven architecture** built on iTerm2's native WebSocket/Protobuf API (`@shadr/iterm2-ts`). The API provides push-based notifications for screen updates, command start/end, prompt events, and session lifecycle — eliminating polling entirely. The agent subscribes to events and reacts, rather than polling and guessing.

---

## Completed (v1.3.1)

All original roadmap items are resolved and live-verified:

| Issue | Summary |
|-------|---------|
| PANE-META | Staging-window-based inventory replaces pane-option metadata |
| ATTACH-VERIFY | View pane existence verified via tmux query |
| LEGACY-GATE | All non-tmux code paths removed, HostTarget object |
| SWAP-SHUFFLE | @pi_name single-swap identity replaces @pi_staging_index two-swap |
| HOST-PLUMBING | HostTarget replaces positional host args |
| HOST-MISMATCH | Host window detected from TMUX_PANE at startup |
| OUTPUT-TRACK | Truncation metadata in completion and peek |
| COMPLETE-BUILTIN | seenNonShell guard prevents false completion for builtins |
| TMUX-ENV-WARN | Environment validation warnings on session start |
| FOCUS-LEAK | Focus reporting disabled on pane TTY after every swap-pane |
| CTX-SIGNAL | Abort signal wired to send C-c and stop completion tracking |
| SCHEMA-COMPAT | prepareArguments aligned with Pi 0.64+ pattern |
| LIST-ATTACHED | Real attach/detach state in list output |

---

## Forward roadmap

### 1. MSG-DELIVERY — Verify Pi 0.64 message delivery fix

**Priority:** Low
**Effort:** Verification only

Pi 0.64.0 fixed extension-queued user messages being dropped during active turns. Verify this works for the silence alert flow. If it does, remove the workaround (if any) and document.

### 2. ITERM2-API-EVAL — Evaluate iTerm2 native API as control plane

**Priority:** High — foundational decision
**Effort:** Research + prototype

The `@shadr/iterm2-ts` library (already used in `pi-term`) provides TypeScript bindings for iTerm2's native WebSocket/Protobuf API. Key capabilities:

- **ScreenUpdateNotification** — real-time notification when a session's screen changes
- **PromptNotification** — command start, command end (with exit status), prompt events
- **Session creation/termination** — create splits, tabs, manage lifecycle
- **Variable monitoring** — watch session variables for state changes
- **Keystroke monitoring** — observe keystrokes in sessions

This could replace tmux as the terminal control layer for iTerm2 users:

| Capability | Current (tmux) | Potential (iTerm2 API) |
|------------|---------------|----------------------|
| Session creation | `tmux new-window` | `CreateTab` / `SplitPane` |
| Output capture | `capture-pane -S -` (polling) | `ScreenUpdateNotification` (push) |
| Command completion | `pane_current_command` polling | `PromptNotification.commandEnd` (push) |
| Output diffs | Not supported | `ScreenUpdateNotification` + screen diff |
| Exit status | Wrapper script + file | `PromptNotification.commandEnd.status` |
| Focus management | `swap-pane` + `select-pane` | Native split/tab focus |

**Questions to answer:**

1. Can `ScreenUpdateNotification` deliver screen diffs efficiently, or only "screen changed" signals?
2. Can sessions be created invisibly (background) and observed without being visible?
3. Does the API support reading screen content (like `capture-pane`) or only change notifications?
4. Is the WebSocket connection reliable for long-running sessions?
5. Can this eliminate the need for tmux entirely on iTerm2, or is tmux still needed for session persistence/detach?
6. What does the `pi-term` repo (`~/workspace/victor/pi-term/`) already prove about the API's reliability?

**Event-driven targets — replace every polling loop:**

| Current polling pattern | Event-driven replacement |
|------------------------|-------------------------|
| `pane_current_command` tick loop for completion | `PromptNotification.commandEnd` push event |
| `capture-pane` periodic reads for silence detection | `ScreenUpdateNotification` — no update = silence |
| Wrapper script + exit-code file for completion status | `PromptNotification.commandEnd.status` |
| `peek` as the only way to read output | `ScreenUpdateNotification` → diff accumulator → agent subscription |
| Silence backoff timers | Absence of `ScreenUpdateNotification` for N seconds |

**Deliverable:** A research document in `docs/engineering/` with findings, and a prototype demonstrating observable shell output via the iTerm2 API.

### 3. OUTPUT-STREAMING — Real-time output diffs to agent

**Priority:** High — core differentiator
**Blocked by:** ITERM2-API-EVAL (determines backend)

Replace peek-based polling with event-driven output streaming. The agent subscribes to shell output and receives only diffs (new content since last observation), non-blocking.

**Architecture:**

```
iTerm2 session
  │
  ├── ScreenUpdateNotification (push)
  │       ↓
  ├── Screen state tracker (maintains current screen content)
  │       ↓
  ├── Diff engine (computes delta from last delivered state)
  │       ↓
  └── Agent subscription (delivers diffs via steer message)
```

**Requirements:**
- Event-driven: no polling loops, no timers, no periodic capture
- Agent subscribes to a shell session's output stream
- Receives diffs (new lines/content since last observation), not full scrollback
- Non-blocking — agent continues working while shells run
- Multiple concurrent observable shells
- Configurable: opt-in per shell (not all shells need observation)
- Backpressure: if agent is busy, diffs accumulate and are delivered as a batch when agent is ready

**Implementation paths:**

- **iTerm2 API path (preferred):** Subscribe to `ScreenUpdateNotification`, maintain screen state, compute diffs, deliver via steer
- **tmux fallback path:** `pipe-pane` to log file, `fs.watch` for changes (still event-driven, not polling), deliver diffs via steer
- **Hybrid:** iTerm2 API for output streaming, tmux for session persistence/detach

### 4. AGENT-PANE-STABILITY — Expose staging-window architecture as reusable primitive

**Priority:** Medium
**Blocked by:** ITERM2-API-EVAL (determines whether tmux staging is still relevant)

The `pi-interactive-subagents` extension suffers from stale pane references — it creates tmux panes that die or get reassigned, then fails when polling output from dead pane IDs (e.g., `can't find pane: %3`).

pi-tmux's staging-window architecture already solves this: staging windows are stable identifiers, pane IDs are transient. This pattern should be extractable as a reusable primitive that other extensions (like pi-interactive-subagents) can use.

**Options:**
- Export a `ManagedTerminalSession` API from pi-tmux that other extensions can consume
- Or, if ITERM2-API-EVAL shows the native API is better, build the primitive on top of that instead
- Key requirement: stable session identity that survives pane lifecycle events

### 5. APPLESCRIPT-AUDIT — Validate or replace AppleScript usage

**Priority:** Medium
**Blocked by:** ITERM2-API-EVAL

Current pi-tmux uses AppleScript for `/tmux-promote` and `attach` actions. The `@shadr/iterm2-ts` library may provide a better path:

- **AppleScript:** Brittle, slow, requires accessibility permissions, hard to debug
- **iTerm2 API:** TypeScript, WebSocket-based, type-safe, push notifications, no accessibility permissions

Audit all AppleScript usage and determine what can be replaced with the native API.

---

## Terminology

Use exact tmux names everywhere. No metaphors, no vague terms.

| Term | Meaning |
|---|---|
| tmux session | A named tmux session (e.g. `13`, `pi-tmux-be23e752-stg`) |
| tmux window | A numbered tab within a tmux session (e.g. window `4` of session `13`) |
| tmux pane | A rectangular region within a window, identified by pane ID (e.g. `%84`) |
| pane ID | Tmux's unique identifier for a pane (e.g. `%84`). Survives `swap-pane`. |
| host session | The tmux session Pi is running in. Detected from `TMUX_PANE` at startup. |
| host window | The tmux window within the host session where Pi's own pane lives. |
| view pane | The split pane next to Pi (pane index `1` in the host window). Shows one command's output at a time. |
| staging session | A separate tmux session (`{name}-stg`) not attached to iTerm2 CC. Command panes are created here. |
| staging window | A tmux window in the staging session. One per command. |
| `@pi_name` | Pane option labeling a command pane with its logical name. The sole identity for a command pane. |
| observable shell | A terminal session whose output is streamed to the agent as diffs, non-blocking. |
