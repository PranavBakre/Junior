# Code Index: Interactive Driver (EXPERIMENTAL)

> [!WARNING]
> This module is **EXPERIMENTAL** and not yet fully developed or tested.

This module provides the "Interactive" execution path, driving Claude Code inside a persistent `tmux` session to utilize the Max subscription instead of API credits.

## Key Files

- [runtime.ts](file:///Users/psbakre/Projects/junior/src/runners/runtime.ts): Orchestrates the choice between headless and interactive drivers.
- [src/claude/tmux-driver.ts](file:///Users/psbakre/Projects/junior/src/claude/tmux-driver.ts) (Internal): Implementation of the tmux driver.

## Mechanism

1. **Session Start**: `tmux new-session -d` starts Claude Code TUI.
2. **Input**: Prompts are injected via `tmux load-buffer` + `paste-buffer -p`.
3. **Observation**: The driver tails the Claude transcript file (`~/.claude/projects/.../*.jsonl`) to extract events.
4. **Completion**: A `system.turn_duration` event in the transcript signals the end of the turn.
