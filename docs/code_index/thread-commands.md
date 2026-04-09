# Code Index: Thread Commands

Parses `!command` prefixes and dispatches them to session actions.

## Code Index

### src/slack + src/session

| Function | File | Purpose |
|----------|------|---------|
| `parseCommand(text)` | `slack/commands.ts` | Splits `!build fix auth` → `{ command: "build", text: "fix auth" }` |
| `SessionManager.handleMessage(event)` | `session/manager.ts` | Dispatches based on `event.command` |

### Supported Commands

| Command | Effect |
|---------|--------|
| `!build <text>` | Sets `agentType: "build"`, creates worktree if needed, spawns Claude |
| `!frontend <text>` | Sets `agentType: "frontend"`, creates worktree |
| `!review <text>` | Sets `agentType: "review"` (read-only agent) |
| `!architect <text>` | Sets `agentType: "architect"` |
| `!repo <name>` | Sets `targetRepo` for the session |
| `!reset` | Clears session state (sessionId, worktree, agent type) |
| `!status` | Returns session info via `onCommandResponse` |
| `!quiet` / `!verbose` | Toggles status update verbosity |

## Command Flow

```
"!build fix the auth bug"
  │
  ├── parseCommand() → { command: "build", text: "fix the auth bug" }
  │
  └── SessionManager.handleMessage()
        ├── agentType = "build"
        ├── AgentRouter.getSystemPrompt("build", targetRepo)
        ├── WorktreeManager.create(repo, threadId)
        └── spawnClaude("fix the auth bug", { systemPrompt, worktreePath })
```

## Dependencies

- **Uses**: `agents/router` (system prompt), `worktree/manager` (isolation)
- **Used by**: `SessionManager` (command dispatch in handleMessage)
