# Code Index: Claude CLI Spawner

Spawns `claude -p` as a child process, parses stream-json output, and collects structured results.

## Code Index

### src/claude

| Symbol | File | Purpose |
|---|---|---|
| `spawnClaude(session, prompt, config, targetRepoCwd?, botToken?, agentIdentity?)` | `spawner.ts` | Spawn CLI process, stream events, return `SpawnHandle` |
| `buildClaudeArgs(session, prompt, config, cwd, mcpConfigPath?, skillAddDir?)` | `args.ts` | Build CLI arg array from session state, effective policy, and optional assignment skill |
| `createStreamParser()` | `parser.ts` | Returns `{ feed(chunk): StreamEvent[] }` — buffers partial lines, validates JSON, drops malformed/unknown |

### Types

| Type | File | Shape |
|---|---|---|
| `StreamEvent` | `types.ts` | Union: `StreamEventInit \| StreamEventAssistant \| StreamEventResult \| StreamEventUser \| StreamEventRateLimit` |
| `ContentBlock` | `types.ts` | Union: `ContentBlockText \| ContentBlockToolUse \| ContentBlockThinking` |
| `SpawnResult` | `src/runners/types.ts` | Provider-neutral `{ provider, sessionId, response, events, exitCode, error }` |
| `SpawnHandle` | `src/runners/types.ts` | Provider-neutral `{ result: Promise<SpawnResult>, onEvent(cb), kill(), pid }` |

`src/claude/types.ts` contains Claude-native stream-json event/content types;
the app-facing result and handle types live in `src/runners/types.ts`.

## Data Flow

```
buildClaudeArgs(session, prompt, config, mcpConfigPath?)
  │
  ▼
Bun.spawn(["claude", ...args], { cwd, env, stdin: "ignore", detached: true })
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

`spawner.ts` writes a per-session generated MCP config under `data/mcp-configs/`.
It is passed for every non-utility run (including Junior-root runs), and utility
commands with explicit `session.cwd` skip Junior's local MCP wiring. The args
also add `--strict-mcp-config` and project `--setting-sources` by default so
developer-global MCP/settings cannot leak into a run. Human-gated agents can
opt into the Slack approval tool; assignment-scoped skills use `--add-dir`.

### CLI flags

Always: `-p`, `--output-format stream-json`, `--verbose`, `--max-turns`,
`--permission-mode`, and (unless disabled) the Junior baseline system prompt.
Conditional: `--resume <sessionId>` when the native session cwd matches,
agent system prompts, `--model`, `--allowedTools`, `--disallowedTools`,
`--add-dir`, `--max-budget-usd`, `--permission-prompt-tool`, `--mcp-config`,
`--strict-mcp-config`, and `--setting-sources`.

## Dependencies

- **Uses**: `Bun.spawn`, `session/types`, `config`, `claude/parser`, `claude/args`
- **Used by**: `SessionManager.runClaudeWithAgent` (wrapped by `lifecycle/timeout.withTimeout`)
