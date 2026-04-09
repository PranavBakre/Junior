# Code Index: Project Setup

Entry point, configuration, logging, and boot sequence.

## Code Index

### src (root)

| Function | File | Purpose |
|----------|------|---------|
| `loadConfig()` | `config.ts` | Reads env vars, returns typed `Config` object |
| `log.info(tag, msg)` | `logger.ts` | Structured log to stdout + daily log file |
| `log.warn(tag, msg)` | `logger.ts` | Warning level |
| `log.error(tag, msg)` | `logger.ts` | Error level |
| `loadPersona()` | `persona.ts` | Reads `~/.openclaw/workspace/IDENTITY.md` + `SOUL.md`, caches |

### Types

| Type | File | Purpose |
|------|------|---------|
| `Config` | `config.ts` | `{ slack, claude, repos, session, redis? }` |
| `RepoConfig` | `config.ts` | `{ name, path, defaultBase }` |

### Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `SLACK_BOT_TOKEN` | yes | — | Bolt app, MCP server, file uploads |
| `SLACK_APP_TOKEN` | yes | — | Socket Mode connection |
| `SLACK_SIGNING_SECRET` | no | `""` | Bolt request verification |
| `CLAUDE_MAX_TURNS` | no | `25` | `--max-turns` flag |
| `CLAUDE_TIMEOUT_MS` | no | `300000` | Process timeout guard |
| `CLAUDE_PERMISSION_MODE` | no | `bypassPermissions` | `--permission-mode` flag |
| `REPOS` | no | `[]` | JSON array of `RepoConfig` |
| `SESSION_STALE_TIMEOUT_MS` | no | `86400000` | Stale session cleanup threshold |
| `SESSION_CLEANUP_INTERVAL_MS` | no | `900000` | Cleanup check interval |
| `REDIS_URL` | no | — | Redis session store |
| `MCP_PORT` | no | `3456` | Bot Slack MCP server port |

## Boot Sequence (`index.ts`)

```
 1. loadConfig()
 2. startMcpServer(botToken)          ← HTTP MCP on port 3456
 3. createSlackApp(config)            ← Bolt app (Socket Mode)
 4. InMemorySessionStore()
 5. SessionManager(store, config)
 6. AgentRouter(repos, agentDir)
 7. WorktreeManager(repos)
 8. Wire: sessionManager.{agentRouter, worktreeManager, slackApp}
 9. SlackResponder(app)
10. Wire callbacks: onResponse, onEvent, onMessageBuffered, onCommandResponse, onError
11. registerHomeTab(app, store)
12. setupGracefulShutdown(sessionManager, store)
13. Start intervals: health (60s), cleanup (15min)
14. app.start()                       ← connect to Slack
15. auth.test() → resolve botUserId + selfBotId
16. registerEventHandlers(app, callback, store, selfBotId)
```

## Dependencies

- **Uses**: all modules (this is the composition root)
- **Used by**: nothing (entry point)
