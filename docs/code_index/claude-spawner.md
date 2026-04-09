# Code Index: Claude CLI Spawner

Spawns `claude -p` as a child process, parses stream-json output, and collects structured results.

## Code Index

### src/claude

| Function | File | Purpose |
|----------|------|---------|
| `spawnClaude(session, prompt, config, targetRepoCwd?, botToken?)` | `spawner.ts` | Spawns CLI process, streams events, returns `SpawnHandle` |
| `buildClaudeArgs(session, prompt, config, mcpConfigPath?)` | `args.ts` | Builds CLI arg array from session state |
| `createStreamParser()` | `parser.ts` | Returns `{ feed(chunk): StreamEvent[] }` — buffers partial lines, validates JSON |

### Types

| Type | File | Purpose |
|------|------|---------|
| `StreamEvent` | `types.ts` | Union: `StreamEventInit \| StreamEventAssistant \| StreamEventResult \| StreamEventUser \| StreamEventRateLimit` |
| `SpawnResult` | `types.ts` | `{ sessionId, response, events[], exitCode, error }` |
| `SpawnHandle` | `types.ts` | `{ result: Promise<SpawnResult>, onEvent(cb), kill(), pid }` |
| `ContentBlock` | `types.ts` | Union: `ContentBlockText \| ContentBlockToolUse \| ContentBlockThinking` |

### Constants

| Constant | File | Purpose |
|----------|------|---------|
| `PROJECT_MCP_CONFIG` | `spawner.ts` | Resolved path to project `.mcp.json` (used for worktree spawns) |

## Data Flow

```
buildClaudeArgs(session, prompt, config)
  │
  ▼
Bun.spawn(["claude", ...args], { cwd, env })
  │
  ├── stdout ──► StreamParser.feed(chunk) ──► StreamEvent[]
  │     ├── init event ──► extract sessionId
  │     ├── assistant event ──► onEvent listeners
  │     └── result event ──► extract response
  │
  └── proc.exited ──► SpawnResult { sessionId, response, events, exitCode, error }
```

## Key Concepts

### Environment Variables Passed to Claude

`spawner.ts` sets these env vars on every spawned process:

| Var | Purpose |
|-----|---------|
| `JUNIOR_SPAWNED` | `"1"` — lets hooks/agents detect they're inside Junior |
| `SLACK_CHANNEL` | Current thread's channel ID |
| `SLACK_THREAD_TS` | Current thread's timestamp |
| `SLACK_BOT_TOKEN` | Bot token for `bin/slack-upload.sh` |

### MCP Config Injection

When `cwd` differs from project root (worktree/target repo), `spawner.ts` passes `--mcp-config` pointing to Junior's `.mcp.json`. This ensures the slack-bot MCP server is reachable regardless of working directory.

### CLI Flags

Always: `-p`, `--output-format stream-json`, `--verbose`, `--max-turns`, `--permission-mode bypassPermissions`.
Conditional: `--resume` (if sessionId), `--append-system-prompt` (if systemPrompt), `--mcp-config` (if worktree).

## Dependencies

- **Uses**: Bun.spawn, `session/types` (ThreadSession), `config` (Claude settings)
- **Used by**: `SessionManager.handleMessage()`, wrapped by `lifecycle/timeout.ts`
