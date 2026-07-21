# Code Index: HTTP Dashboard

Localhost-only HTTP server for operator inspection (sessions, dev-servers, workflows, logs, docs, and memory projections). Off by default; enabled via `HTTP_DASHBOARD_PORT`. Binds 127.0.0.1 and intentionally has no auth; do not expose it beyond a trusted local operator environment.

## Code Index

### src/http

| Symbol | File | Purpose |
|---|---|---|
| `startHttpServer(deps)` | `server.ts` | Bun.serve on 127.0.0.1:port; routes API + serves `public/index.html` |
| `HttpServerDeps` | `server.ts` | `{ store, config, devServerManager, devServerQueue, repos, workflowRegistry, workflowStore, memoryStore? }` |
| `handleHealth(store, config, startedAt)` | `routes/health.ts` | `GET /api/health` — uptime, session counts, agent counts, repo list |
| `handleSessions(store)` | `routes/sessions.ts` | `GET /api/sessions` — list (strips worktreePath, systemPrompt, cwd, pid, slackIdentity, pendingMessages flattened to count) |
| `handleSessionDetail(store, threadId)` | `routes/sessions.ts` | `GET /api/sessions/:threadId` — full session JSON |
| `handleDevServers(manager, queue, repos)` | `routes/dev-server.ts` | `GET /api/dev-server` — per-repo state, idle TTL remaining, queue depth |
| `handleWorkflows(registry, store)` | `routes/workflows.ts` | `GET /api/workflows` — workflow definitions, persisted state, recent runs, registry errors |
| `handleLogs(searchParams)` | `routes/logs.ts` | `GET /api/logs?date=YYYY-MM-DD` — parses daily log file (strict date regex prevents path traversal) |
| `handleMemoryList()` | `routes/memory.ts` | `GET /api/memory` — list files under `docs/` |
| `handleMemoryRead(filePath)` | `routes/memory.ts` | `GET /api/memory/:path` — read a doc file (path-traversal guarded) |
| `handleMemoryRecall(store, params)` | `routes/memory.ts` | `GET /api/memory/recall` — semantic claim recall without recording dashboard usage |
| `handleMemoryProjection(store)` | `routes/memory.ts` | `GET /api/memory/projection` — PCA/KNN projection for the memory cloud view |

## Routes

```
GET /                       → public/index.html
GET /api/health             → handleHealth
GET /api/sessions           → handleSessions
GET /api/sessions/<id>      → handleSessionDetail
GET /api/dev-server         → handleDevServers
GET /api/workflows          → handleWorkflows
GET /api/logs?date=...      → handleLogs
GET /api/memory             → handleMemoryList
GET /api/memory/<path>      → handleMemoryRead
GET /api/memory/recall      → handleMemoryRecall (503 if unavailable)
GET /api/memory/projection  → handleMemoryProjection (503 if unavailable)
```

## Key Concepts

### Loopback-only threat model

Binds `127.0.0.1`. No CORS headers — same-origin from `public/index.html`. Don't expose this port. No auth. The internal MCP server is a separate loopback-only service.

### Path traversal guards

- Logs: `date` must match `^\d{4}-\d{2}-\d{2}$` exactly.
- Memory: rejects `..` and absolute paths; verifies resolved path stays inside `docs/`.

### Boot wiring

`index.ts` dynamic-imports `./http/server.ts` inside a try/catch — a port conflict on dashboard must not crash the bot.

## Dependencies

- **Uses**: `Bun.serve`, `SessionStore`, `DevServerManager`, `DevServerQueue`, `WorkflowRegistry`, `WorkflowStore`, optional `MemoryStore`, `RepoConfig`, `logger`
- **Used by**: `src/index.ts` (gated on `config.http.enabled`)
