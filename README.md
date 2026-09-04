# pi-sessions (v2: Agent View)

`pi-sessions` turns one Pi process into an in-process live-session multiplexer with a Claude Code-style **Agent View**.

Multiple Pi sessions can stay alive concurrently. Exactly one session owns the terminal at a time. Background sessions continue to run and notify you when they need input.

## Install

Install directly from your fork:

```bash
pi install git:github.com/pha123661/pi-sessions
```

## Agent View Interface

```text
Your conversation moved to the background — enter opens it · esc returns to it · ctrl+c twice quits

Needs input
✻ current session       pi-sessions                                                                            14s

Completed
∙ General assistance ⑂  Updated memory/use-jj-vcs.md and MEMORY.md to specify standard Git for all versi…  #2  16s














──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯ describe a task for a new session
──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ctrl+r to rename          ctrl+j for newline    ctrl+t to pin to top    ctrl+x to stop    ? to close
  ctrl+s to switch views    @ to mention          alt+1 to open           esc to quit
```

## Core Interactions & Shortcuts

### 1. Backgrounding (`←` or `/sessions`)
- **Foreground to Background:** In an active session, press `←` (Left Arrow) on an empty prompt to send the session to the background and open the Agent View.
- **Return:** Press `Esc` or `←` from the Agent View to return to your previous foreground session.

### 2. Task Dispatching (`❯ describe a task for a new session`)
- Typing directly in the prompt bar is for describing a **new task**.
- **`Enter`**: Spawns a new background session in the current folder, immediately begins executing the prompt, places it under `Working` with `✻`, and leaves the Agent View open so you can monitor progress or dispatch more tasks.
- **`Ctrl+Enter`**: Dispatches the task and immediately attaches the terminal to the new session.
- **`Enter` on empty input**: Attaches to the selected session.
- **`Ctrl+J` / `Shift+Enter`**: Inserts a newline into the dispatch prompt.

### 3. Session Grouping & Status
Sessions are dynamically grouped:
- **`Needs input`**: Foreground sessions or background sessions waiting on user interaction (marked with `✻`).
- **`Working`**: Background sessions actively executing prompts or running tools (marked with `✻`).
- **`Completed`**: Idle live sessions and past sessions saved on disk (marked with `∙`).

### 4. Controls & List Management
- **`Ctrl+S` (Switch views):** Toggles between sessions in the **Current folder** and **All folders** across the machine.
- **`Ctrl+T` (Pin to top):** Toggles pin status (`📌`) for the selected session, keeping it anchored at the top of its section.
- **`Ctrl+R` (Rename):** Opens an inline rename bar to change the session name on the fly and persist it to session metadata.
- **`Ctrl+X` (Stop):** Stops a running background session, or removes a completed session.
- **`Alt+1` .. `Alt+9`:** Quickly jumps to and attaches session #1 through #9.
- **`Space`:** Opens or closes the **Peek Panel** showing the latest multi-line transcript excerpt for the selected session.
- **`Ctrl+C`:** Clears the prompt if typed; double-tap on empty input quits the Agent View.
- **`?`:** Toggles the keyboard shortcut reference modal.

## Configuration

In `~/.pi/agent/settings.json`, you can configure the default scope for the Agent View:

```json
{
  "sessions": {
    "defaultScope": "current"
  }
}
```

Options for `defaultScope`:
- `"current"`: Only shows sessions from the current working directory by default (toggleable via `Ctrl+S`).
- `"all"`: Shows sessions across all directories on the machine by default.

## Runtime Model

```text
parent Pi process
  └─ pi-sessions agent view
      ├─ parent: existing InteractiveMode (Needs Input)
      ├─ child A: AgentSessionRuntime (Working ✻ - Running prompt in background)
      ├─ child B: AgentSessionRuntime (Needs Input ? - Waiting on user permission)
      └─ child C: AgentSessionRuntime / Disk Session (Completed ∙)
```
