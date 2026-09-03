# pi-sessions (v2: Agent View)

`pi-sessions` turns one Pi process into a live-session multiplexer with a Claude Code-style **Agent View**.

Multiple Pi sessions can stay alive concurrently. Exactly one session owns the terminal at a time. Background sessions continue to run and notify you when they need input.

## Install

Install directly from your fork:

```bash
pi install git:github.com/pha123661/pi-sessions
```

## V2 Core Interactions & Shortcuts

This extension implements the 4 core Claude Code parallel session UX interactions:

### 1. Backgrounding (`←`)
- **Foreground to Background:** In a running session, press `←` (Left Arrow) on an empty prompt to send the session to the background and open the Agent View.
- **Return:** Press `←` again from the Agent View to return to your previous foreground session.

### 2. Peeking & Replying (`Space`)
- **Peek Panel:** Press `Space` on a selected background agent in the list to open the Peek Panel. This shows the latest output or what the agent is currently waiting for without switching full context.
- **Quick Reply:** Type a reply in the Agent View input and press `Enter` to send it directly to a waiting background session without leaving the Agent View.

### 3. Attaching (`Enter` or `→`)
- Press `Enter` or `→` on a selected session to **attach** your terminal to it, handing over full TUI control.

### 4. List Management
- `Ctrl+R`: Rename the selected session.
- `Ctrl+X`: Stop a working session (press again to delete).
- `Ctrl+T`: Pin a session to keep its memory resident.
- `Shift+↑` / `Shift+↓`: Manually reorder sessions in the table.

## Runtime model

```text
parent Pi process
  └─ pi-sessions agent view
      ├─ parent: existing InteractiveMode
      ├─ child A: AgentSessionRuntime + InteractiveMode (Working)
      ├─ child B: AgentSessionRuntime + InteractiveMode (Needs Input)
      └─ child C: AgentSessionRuntime + InteractiveMode (Completed)
```

Child sessions are real native `InteractiveMode` instances, not embedded panels. When active, child UI is full-screen and native Pi slash-command UI works as usual.
