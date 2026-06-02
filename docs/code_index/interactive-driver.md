# Code Index: Interactive Driver (EXPERIMENTAL)

> [!WARNING]
> This module is experimental and opt-in. The implementation exists behind `DEFAULT_CLAUDE_DRIVER=tmux`, but the default remains headless while it soaks.

This module provides the interactive Claude execution path, driving Claude Code inside a persistent `tmux` session instead of spawning `claude -p` for every turn.

## Code Index

| Symbol | File | Purpose |
|---|---|---|
| `createDriver(mode, config)` | `src/claude/factory.ts` | Selects `HeadlessDriver` or `TmuxDriver`. |
| `HeadlessDriver` | `src/claude/headless-driver.ts` | Wraps the existing `claude -p` spawner path. |
| `TmuxDriver` | `src/claude/tmux-driver.ts` | Starts/reuses tmux sessions, pastes prompts, tails transcripts, and supports interrupts. |
| `adaptTranscriptLine(...)` | `src/claude/transcript-adapter.ts` | Converts Claude transcript JSONL lines into stream events. |
| `reconcileTmuxSessions(...)` | `src/lifecycle/tmux-reconcile.ts` | Reattaches or downgrades tmux sessions on bot boot. |
| `evictIdleTmuxSessions(...)` | `src/lifecycle/tmux-evict.ts` | Kills idle tmux sessions while preserving resume IDs. |

## Mechanism

1. **Session Start**: `tmux new-session -d` starts Claude Code TUI.
2. **Input**: Prompts are injected via `tmux load-buffer` + `paste-buffer -p`.
3. **Observation**: The driver tails the Claude transcript file (`~/.claude/projects/.../*.jsonl`) to extract events.
4. **Completion**: A `system.turn_duration` event in the transcript signals the end of the turn.
