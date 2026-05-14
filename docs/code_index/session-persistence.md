# Code Index: Session Persistence

Pluggable backing store for `ThreadSession` state plus the admin registry. SQLite is the production default; in-memory store is used for tests and `SESSION_STORE=memory`.

## Code Index

### src/session/store

| Symbol | File | Purpose |
|---|---|---|
| `SessionStore` (interface) | `interface.ts` | `get / set / delete / getAll / getRecent / updateActivity / extraAdmins` |
| `createSessionStore(config)` | `factory.ts` | Picks `InMemorySessionStore` or `SqliteSessionStore(config.session.sqlitePath)` |
| `InMemorySessionStore` | `memory.ts` | `Map<threadId, ThreadSession>` backed; `extraAdmins()` always returns empty |
| `SqliteSessionStore(dbPath)` | `sqlite.ts` | `bun:sqlite` with WAL; creates parent dir; exposes `close()` |
| `normalizeSession(session)` | `sqlite.ts` | Backfills `leadSessionId`, `agentSessions`, `worktreePaths`, `muted` on legacy rows |

## SQLite schema

```sql
CREATE TABLE sessions (
  thread_id     TEXT PRIMARY KEY,
  json          TEXT NOT NULL,      -- whole ThreadSession blob
  last_activity INTEGER NOT NULL,
  status        TEXT NOT NULL
);
CREATE INDEX idx_sessions_last_activity ON sessions(last_activity);
CREATE INDEX idx_sessions_status        ON sessions(status);

CREATE TABLE agent_sessions (
  thread_id     TEXT NOT NULL,
  agent_name    TEXT NOT NULL,
  session_id    TEXT,
  status        TEXT DEFAULT 'idle',
  last_activity INTEGER,
  PRIMARY KEY (thread_id, agent_name),
  FOREIGN KEY (thread_id) REFERENCES sessions(thread_id)
);

CREATE TABLE admins (
  slack_user_id TEXT PRIMARY KEY,
  added_at      INTEGER NOT NULL
);
```

PRAGMAs: `journal_mode = WAL`, `synchronous = NORMAL`.

## Data Flow

```
SessionManager.set(threadId, session)
  │
  ├── normalizeSession(session)           ← migration safety
  ├── UPSERT into sessions (json blob)
  └── syncAgentSessions(threadId, ...)    ← txn: DELETE + bulk INSERT into agent_sessions

SessionManager.get(threadId)
  │
  ├── SELECT json FROM sessions           ← returns undefined if missing
  ├── normalizeSession + JSON.parse
  └── loadAgentSessions(session)          ← rehydrates agent_sessions rows
```

## Key Concepts

### Hybrid blob + columns

The full `ThreadSession` lives as JSON in `sessions.json`. `agent_sessions` mirrors per-agent slices so they can be queried and updated independently (the dashboard's `/api/sessions` and `getRecent` reads benefit). `set()` rewrites both atomically per thread.

### Pending messages survive restarts but go stale

`pendingMessages` are persisted in the JSON blob. Per CLAUDE.md rule 11, the Claude process they were queued behind is dead on restart — treat them as stale, don't auto-drain.

### Admin model

One bootstrap admin in `ADMIN_SLACK_USER_ID` env var. Additional admins inserted directly into the `admins` table (no API yet). `SessionManager.isAdmin()` reads on every call (no cache); inserts take effect immediately. Memory store always reports zero extras — local-dev fallback opens commands to everyone when neither tier is set.

### `getRecent(sinceMs)`

Used by the home tab to scope the listing to the `HOME_WINDOW_MS` window (2 days default). Cleanup and orphan health still scan all rows via `getAll()`.

## Dependencies

- **Uses**: `bun:sqlite`, `node:fs` (mkdir for db dir), `session/types`
- **Used by**: `SessionManager`, lifecycle (cleanup, health, shutdown), `slack/home`, `support/router`, HTTP dashboard
