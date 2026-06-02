# Code Index: Project Setup

Entry point, configuration, logging, persona loading, and boot sequence.

## Code Index

### src (root)

| Symbol | File | Purpose |
|---|---|---|
| `loadConfig()` | `config.ts` | Reads env vars, validates, returns typed `Config` |
| `log.info / log.warn / log.error` | `logger.ts` | Structured log to stdout + daily file `logs/YYYY-MM-DD.log` |
| `loadPersona()` | `persona.ts` | Reads `identity/junior/IDENTITY.md` + `SOUL.md` from the submodule; cached |

### Types

| Type | File | Shape |
|---|---|---|
| `Config` | `config.ts` | `{ slack, claude, repos, session, channelDefaults, adminSlackUserId, http }` |
| `RepoConfig` | `config.ts` | `{ name, path, defaultBase, worktreeSetupCommand?, devCommand?, devPort?, readyUrl? }` |
| `SessionStoreKind` | `config.ts` | `"memory" \| "sqlite"` |

### Environment Variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `SLACK_BOT_TOKEN` | yes | — | Bolt + MCP server + file uploads |
| `SLACK_APP_TOKEN` | yes | — | Socket Mode |
| `SLACK_SIGNING_SECRET` | no | `""` | Bolt request verification |
| `CLAUDE_MAX_TURNS` | no | `25` | `--max-turns` |
| `CLAUDE_TIMEOUT_MS` | no | `300000` | Process timeout guard |
| `CLAUDE_PERMISSION_MODE` | no | `bypassPermissions` | `--permission-mode` |
| `CLAUDE_MODEL` | no | unset | Default `--model` |
| `REPOS` | no | `[]` | JSON array of `RepoConfig`; trailing slashes stripped from `.path` |
| `SESSION_STORE` | no | `sqlite` | `memory \| sqlite` |
| `SESSION_DB_PATH` | no | `data/sessions.db` | SQLite path (parent dir auto-created) |
| `SESSION_STALE_TIMEOUT_MS` | no | `86400000` | Stale-session deletion threshold |
| `SESSION_CLEANUP_INTERVAL_MS` | no | `900000` | Cleanup tick |
| `SESSION_DEFAULT_VERBOSITY` | no | `normal` | `quiet \| normal \| verbose` |
| `HOME_WINDOW_MS` | no | `172800000` | 2-day window for Home tab |
| `CHANNEL_DEFAULTS` | no | `{"C05557KKV37":{"agentType":"lead"}}` | JSON `{channelId → {agentType}}` |
| `ADMIN_SLACK_USER_ID` | no | unset | Bootstrap admin (rest in `admins` table) |
| `HTTP_DASHBOARD_PORT` | no | unset (disabled) | Strict positive int 1-65535; throws on invalid |
| `MCP_PORT` | no | `3456` | Bot Slack MCP server port (read in `src/mcp/slack-server.ts`) |

## Boot Sequence (`index.ts`)

```
 1. loadConfig()
 2. createSlackApp(config)              ← Bolt + Socket Mode, ignoreSelf=false
 3. createSessionStore(config)
 4. SessionManager(store, config)
 5. AgentRouter(repos, ".claude/agents", "agents-org")
 6. WorktreeManager(repos)
 7. DevServerManager(repos, worktreeManager)
 8. DevServerQueue(devServerManager, repos)
 9. startMcpServer(botToken, store, worktreeManager)   ← HTTP MCP on MCP_PORT
10. Wire: sessionManager.{agentRouter, worktreeManager, slackApp}
11. SlackResponder(app)
12. AgentDispatcher(sessionManager, supportChannels, { devServerQueue, sessionStore, slackClient, repos })
13. Wire SessionManager callbacks: onResponse, onEvent, onMessageBuffered, onCommandResponse, onReaction, onError
14. registerHomeTab(app, store, homeWindowMs)
15. setupGracefulShutdown(sessionManager, store, devServerManager)
16. Intervals: orphan health (60s), stale cleanup (cleanupIntervalMs)
17. await loadOverlayIdentities("agents-org")   ← non-fatal
18. await devServerManager.bootstrap()                  ← non-fatal
19. await app.start()                                   ← Socket Mode connect
20. auth.test()  → sessionManager.botUserId, selfBotId
21. registerEventHandlers(app, dispatcher.handleMessage, store, selfBotId, botUserId, autoTriggerChannels)
22. if (http.enabled) startHttpServer(...)              ← non-fatal
```

## Logger

Daily file rotation; format: `<ISO> [LEVEL] [tag] message`. Writes go to both stdout and `logs/YYYY-MM-DD.log`. Failures to append are swallowed (don't crash on disk-full).

## Persona

`identity/junior/IDENTITY.md` + `SOUL.md` are concatenated and cached on first call. Fallback string used when both files are missing. The directory is a git submodule (`PranavBakre/junior-identity`).

## Dependencies

- **Uses**: every module (composition root)
- **Used by**: nothing
