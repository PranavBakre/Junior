# HTTP Dashboard

## Problem

Operators running junior on a server have no live view of what's happening: which threads are active, which agents are busy, which dev-servers are running and on what branch, what the recent logs look like. The Slack home tab covers thread-list use cases but doesn't surface dev-server queue state, structured logs, or per-agent run state.

**Who has this problem:** The operator (Pranav, mostly) tailing logs and `ps`ing for stuck processes.
**What happens today:** SSH + `tail -f logs/<date>.log` + `sqlite3 data/sessions.db`.
**"Finally" moment:** Open `http://127.0.0.1:<port>` on the host, see sessions / dev-servers / logs / docs in one page.

## Shape

```
src/http/
├── server.ts              -- Bun.serve, route table, single fetch handler
└── routes/
    ├── health.ts          -- uptime + session/agent counters
    ├── sessions.ts        -- list + per-thread detail
    ├── dev-server.ts      -- DevServerManager + DevServerQueue state
    ├── logs.ts            -- tail logs/<date>.log with tag/level filters
    └── memory.ts          -- list/read docs/**/*.md (parity with Friday)
```

Bun-native: no router framework, no auth, no CORS. Static `public/index.html` is served at `/` from the same origin as the API, so cross-origin access has no reason to exist.

## Security posture

- **Loopback-only.** Binds `127.0.0.1` — never reachable off-host without an explicit SSH tunnel. This is the entire threat model; there is no auth layer behind it.
- **Same-origin.** Dashboard HTML is served by the same Bun process. No CORS headers — adding `Access-Control-Allow-Origin: *` would only let arbitrary websites the operator visits read this server's data.
- **Path-traversal rejection at the input layer.** `/api/logs?date=` accepts only `YYYY-MM-DD` (strict regex); `/api/memory/<path>` rejects `..` and absolute paths and verifies the resolved path stays inside `docs/`. Reject early, don't sanitize after concatenation.
- **Projection on `/api/sessions`.** Filesystem paths (`worktreePath`, `cwd`), PIDs (`pid`), prompt-engineering details (`systemPrompt`), and `slackIdentity` are stripped before serialization. `pendingMessages` is reduced to a length count — message bodies never leave the box.

## Endpoints

| Endpoint | Returns |
|---|---|
| `GET /` | `public/index.html` (dashboard UI) |
| `GET /api/health` | `{ status, uptime, startedAt, sessions: {total,busy,idle,draining,errors}, agents: {total,busy}, repos[] }` |
| `GET /api/sessions` | Sessions sorted by `lastActivity` desc, with filtered projection and a reshaped `agents[]` array per session |
| `GET /api/sessions/:threadId` | Full `ThreadSession` for one thread (no projection — for the detail view) |
| `GET /api/dev-server` | Per-repo `{ running, pid, branch, startedAt, lastUsedAt, idleMsRemaining, holder, waiters }` plus top-level `idleTtlMs` |
| `GET /api/logs?date=YYYY-MM-DD&tail=N&tag=&level=` | Parsed entries from `logs/<date>.log` |
| `GET /api/memory` | List of `docs/**/*.md` paths |
| `GET /api/memory/:path` | Contents of one doc file |

`OPTIONS *` returns 204 (preflight handler kept for browsers that probe; no CORS headers attached). Unknown paths return JSON `{ error: "not found" }` 404. Handler exceptions log to the `http` tag and return JSON 500 — the bot does not die on a route bug.

## Configuration

```
HTTP_DASHBOARD_PORT=4567  # positive integer 1-65535. Unset = disabled.
```

- Unset/empty → `{ enabled: false }`, `startHttpServer` is never called from `index.ts`.
- Anything other than a positive integer in range throws at config load — better to fail boot than silently bind to a surprise port.
- `Bun.serve` startup failures (port in use, permissions) are caught and logged; the bot continues without the dashboard.

## Integration points

- **`SessionStore` ([session-persistence.md](session-persistence.md), [session-management.md](session-management.md)).** All session reads go through the interface — sqlite in production, in-memory in dev/tests. `/api/health` and `/api/sessions` call `getAll()`; `/api/sessions/:id` calls `get(threadId)`. `agentSessions` is flattened into `agents[]` so the UI can render multi-agent threads without knowing the storage shape.
- **`DevServerManager` ([process-lifecycle.md](process-lifecycle.md)).** `/api/dev-server` calls `manager.status()` for live `DevServerState` and `manager.getIdleTtlMs()` for the configured TTL (no hard-coded 20 min in the route — single source of truth).
- **`DevServerQueue`.** `queue.readQueueDepth(repo)` supplies `{ holder, waiters }` so the dashboard can show "you're 3rd in line" parity with `!devserver status`.
- **`logs/<date>.log`.** Written by `src/logger.ts`. The route is read-only and parses the same line format the logger emits (`<iso> [LEVEL] [tag] message`).
- **`docs/`.** Read-only doc browser, scoped to the project's `docs/` directory.

## Dependencies

- [session-management.md](session-management.md) — shape of `ThreadSession` / `AgentSession` consumed by `/api/sessions`.
- [session-persistence.md](session-persistence.md) — the `SessionStore` interface backing those reads.
- [process-lifecycle.md](process-lifecycle.md) — `DevServerManager` / `DevServerQueue` invariants surfaced by `/api/dev-server`.

## Cut list (true v2)

- Auth (token, OAuth). Loopback binding is enough until junior runs on a multi-tenant host.
- Server-Sent Events / WebSocket push for live updates. Today the UI polls.
- Write endpoints (kill a session, evict a dev-server slot). Stays read-only — destructive ops go through Slack `!` commands so they're auditable.
- Per-thread message-body view. `pendingMessages` lengths only, by design.
