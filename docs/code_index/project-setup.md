# Code Index: Project Setup

## Files

| File | Purpose |
|---|---|
| `src/index.ts` | Entry point: bootstraps all subsystems, wires callbacks, starts app |
| `src/config.ts` | Environment variable loading and config types |
| `src/logger.ts` | Structured logging to stdout and daily log files |
| `src/persona.ts` | Loads Junior's identity from openclaw workspace |

## Key Exports

### `src/config.ts`
- `Config` — top-level config type with `slack`, `claude`, `repos`, `session`, `redis?` sections
- `RepoConfig` — `{ name, path, defaultBase }` for target repositories
- `loadConfig(): Config` — reads from env vars, throws on missing required vars

### `src/logger.ts`
- `log.info(tag, message)`, `log.warn(tag, message)`, `log.error(tag, message)`
- Writes to stdout with `[HH:MM:SS] [TAG] message` format
- Also appends to `logs/YYYY-MM-DD.log`

### `src/persona.ts`
- `loadPersona(): Promise<string>` — reads `~/.openclaw/workspace/IDENTITY.md` + `SOUL.md`, caches

## Environment Variables

| Variable | Required | Default | Used by |
|---|---|---|---|
| `SLACK_BOT_TOKEN` | yes | — | Bolt app, MCP server, file uploads |
| `SLACK_APP_TOKEN` | yes | — | Socket Mode connection |
| `SLACK_SIGNING_SECRET` | no | `""` | Bolt app verification |
| `CLAUDE_MAX_TURNS` | no | `25` | `--max-turns` flag |
| `CLAUDE_TIMEOUT_MS` | no | `300000` | Process timeout guard |
| `CLAUDE_PERMISSION_MODE` | no | `bypassPermissions` | `--permission-mode` flag |
| `REPOS` | no | `[]` | JSON array of `RepoConfig` |
| `SESSION_STALE_TIMEOUT_MS` | no | `86400000` | Stale session cleanup |
| `SESSION_CLEANUP_INTERVAL_MS` | no | `900000` | Cleanup check interval |
| `REDIS_URL` | no | — | Redis session store |
| `MCP_PORT` | no | `3456` | Bot Slack MCP server port |

## Boot Sequence (`index.ts`)

```
1. loadConfig()
2. startMcpServer(botToken)          ← MCP HTTP server on port 3456
3. createSlackApp(config)            ← Bolt app (Socket Mode)
4. InMemorySessionStore()
5. SessionManager(store, config)
6. AgentRouter(repos, agentDir)
7. WorktreeManager(repos)
8. Wire: sessionManager.agentRouter, .worktreeManager, .slackApp
9. SlackResponder(app)
10. Wire callbacks: onResponse, onEvent, onMessageBuffered, onCommandResponse, onError
11. registerHomeTab(app, store)
12. setupGracefulShutdown(sessionManager, store)
13. Start periodic intervals: health (60s), cleanup (15min)
14. app.start()                       ← connect to Slack
15. auth.test() → resolve botUserId, selfBotId
16. registerEventHandlers(app, callback, store, selfBotId)
```
