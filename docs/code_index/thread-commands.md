# Code Index: Thread Commands

## Files

| File | Purpose |
|---|---|
| `src/slack/commands.ts` | Parses `!command` prefix from message text |
| `src/session/manager.ts` | Handles parsed commands in `handleMessage()` |

## Key Exports

### `src/slack/commands.ts`
- `parseCommand(text): ParsedCommand` — `{ command: string | null, text: string }`
  - `"!build fix auth"` → `{ command: "build", text: "fix auth" }`
  - `"hello world"` → `{ command: null, text: "hello world" }`

## Supported Commands

Commands are parsed in `events.ts` and handled in `SessionManager.handleMessage()`:

| Command | Effect |
|---|---|
| `!build <text>` | Sets `agentType: "build"`, creates worktree if needed, spawns Claude |
| `!frontend <text>` | Sets `agentType: "frontend"`, creates worktree if needed |
| `!review <text>` | Sets `agentType: "review"` (read-only agent) |
| `!architect <text>` | Sets `agentType: "architect"` |
| `!repo <name>` | Sets `targetRepo` for the session |
| `!reset` | Clears session state (sessionId, worktree, agent type) |
| `!status` | Returns session info (status, agent, worktree, message count) |
| `!quiet` / `!verbose` | Toggles status update verbosity |

## Command Flow

```
Slack message: "!build fix the auth bug"
  │
  ├── events.ts: parseCommand() → { command: "build", text: "fix the auth bug" }
  │
  └── SessionManager.handleMessage(event)
        ├── event.command === "build"
        ├── Set session.agentType = "build"
        ├── AgentRouter.getSystemPrompt("build", targetRepo) → system prompt
        ├── Set session.systemPrompt
        ├── WorktreeManager.create(repo, threadId) → worktree path
        ├── Set session.worktreePath
        └── Spawn Claude with "fix the auth bug" + system prompt + worktree cwd
```
