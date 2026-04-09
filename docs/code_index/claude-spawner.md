# Code Index: Claude CLI Spawner

## Files

| File | Purpose |
|---|---|
| `src/claude/spawner.ts` | Spawns `claude -p` as child process, streams events, collects result |
| `src/claude/args.ts` | Builds CLI argument array from session state |
| `src/claude/parser.ts` | Newline-delimited JSON stream parser |
| `src/claude/types.ts` | Type definitions for stream events and spawn handles |

## Key Exports

### `src/claude/spawner.ts`
- `spawnClaude(session, prompt, config, targetRepoCwd?, botToken?): SpawnHandle`
  - Spawns `claude` with args from `buildClaudeArgs()`
  - Sets cwd to worktree or target repo or project root
  - Passes env vars: `JUNIOR_SPAWNED`, `SLACK_CHANNEL`, `SLACK_THREAD_TS`, `SLACK_BOT_TOKEN`
  - Passes `--mcp-config` pointing to project `.mcp.json` when cwd differs from project root
  - Returns `SpawnHandle` with `result` promise, `onEvent` callback, `kill()`, and `pid`

### `src/claude/args.ts`
- `buildClaudeArgs(session, prompt, config, mcpConfigPath?): string[]`
  - Always: `-p`, `--output-format stream-json`, `--verbose`, `--max-turns`, `--permission-mode`
  - Conditional: `--resume` (if sessionId), `--append-system-prompt` (if systemPrompt), `--mcp-config` (if path provided)

### `src/claude/parser.ts`
- `createStreamParser(): StreamParser` — returns `{ feed(chunk): StreamEvent[] }`
  - Buffers partial lines across chunks
  - Parses each complete line as JSON
  - Validates against known event types: `system`, `assistant`, `user`, `result`

### `src/claude/types.ts`
- `StreamEvent` — union: `StreamEventInit | StreamEventAssistant | StreamEventResult | StreamEventUser | StreamEventRateLimit`
- `SpawnResult` — `{ sessionId, response, events[], exitCode, error }`
- `SpawnHandle` — `{ result: Promise<SpawnResult>, onEvent(cb), kill(), pid }`
- `ContentBlock` — union: `ContentBlockText | ContentBlockToolUse | ContentBlockThinking`

## Data Flow

```
buildClaudeArgs(session, prompt, config)
  │
  ▼
Bun.spawn(["claude", ...args], { cwd, env })
  │
  ├── stdout ──► StreamParser.feed(chunk) ──► StreamEvent[]
  │                                              │
  │     ┌── init event ──► extract sessionId     │
  │     ├── assistant event ──► onEvent listeners │
  │     └── result event ──► extract response     │
  │                                               │
  └── proc.exited ──► SpawnResult { sessionId, response, events, exitCode, error }
```

## Constants

- `PROJECT_MCP_CONFIG` — resolved path to project `.mcp.json` (used for worktree spawns)
