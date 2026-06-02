# Code Index: Claude CLI Spawner

Spawns `claude -p` as a child process, parses stream-json output, and collects structured results.

## Code Index

### src/claude

| Symbol | File | Purpose |
|---|---|---|
| `spawnClaude(session, prompt, config, targetRepoCwd?, botToken?, agentIdentity?)` | `spawner.ts` | Spawn CLI process, stream events, return `SpawnHandle` |
| `buildClaudeArgs(session, prompt, config, mcpConfigPath?)` | `args.ts` | Build CLI arg array from session state |
| `createStreamParser()` | `parser.ts` | Returns `{ feed(chunk): StreamEvent[] }` — buffers partial lines, validates JSON, drops malformed/unknown |

### Types

| Type | File | Shape |
|---|---|---|
| `StreamEvent` | `types.ts` | Union: `StreamEventInit \| StreamEventAssistant \| StreamEventResult \| StreamEventUser \| StreamEventRateLimit` |
| `ContentBlock` | `types.ts` | Union: `ContentBlockText \| ContentBlockToolUse \| ContentBlockThinking` |
| `SpawnResult` | `types.ts` | `{ sessionId, response, events, exitCode, error }` |
| `SpawnHandle` | `types.ts` | `{ result: Promise<SpawnResult>, onEvent(cb), kill(), pid }` |

## Data Flow

```
buildClaudeArgs(session, prompt, config, mcpConfigPath?)
  │
  ▼
Bun.spawn(["claude", ...args], { cwd, env })
  │
  ├── stdout ──► StreamParser.feed(chunk) ──► StreamEvent[]
  │     ├── system+init  ──► capture sessionId
  │     ├── assistant    ──► track lastAssistantText, notify listeners
  │     └── result       ──► resultText
  │
  └── proc.exited ──► SpawnResult { sessionId, response = result.text || lastAssistantText, events, exitCode, error }
```

## Key Concepts

### cwd resolution

`session.cwd ?? session.worktreePath ?? targetRepoCwd ?? process.cwd()`. `session.cwd` is set by utility commands (e.g. `!adhoc`) and uses a dedicated temp dir.

### Environment variables passed to Claude

| Var | Purpose |
|---|---|
| `JUNIOR_SPAWNED` | `"1"` — lets hooks/agents detect they're inside Junior |
| `SLACK_CHANNEL` | Current thread's channel ID |
| `SLACK_THREAD_TS` | Current thread's timestamp |
| `JUNIOR_AGENT_NAME` | `session.activeAgentName ?? "lead"` |
| `JUNIOR_SLACK_USERNAME` | From `agentIdentity` (when present) |
| `JUNIOR_SLACK_ICON_EMOJI` | From `agentIdentity` (when present) |
| `JUNIOR_SLACK_ICON_URL` | From `agentIdentity.imageUrl` (when present and no emoji icon is set) |
| `SLACK_BOT_TOKEN` | When `botToken` arg passed — enables `bin/slack-upload.sh` |

### MCP config injection

Module-private constant `PROJECT_MCP_CONFIG` resolves to junior's `.mcp.json`. Passed as `--mcp-config` when `cwd` differs from project root AND `session.cwd` is not set. Utility-command spawns (`session.cwd` set) skip MCP — they use cloud integrations, not the local slack-bot MCP.

### CLI flags

Always: `-p`, `--output-format stream-json`, `--verbose`, `--max-turns`, `--permission-mode`.
Conditional: `--resume <sessionId>`, `--append-system-prompt`, `--model`, `--mcp-config`.

## Dependencies

- **Uses**: `Bun.spawn`, `session/types`, `config`, `claude/parser`, `claude/args`
- **Used by**: `SessionManager.runClaudeWithAgent` (wrapped by `lifecycle/timeout.withTimeout`)
