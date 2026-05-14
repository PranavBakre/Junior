# Session Persistence

## Problem

Junior's session state lives in an in-memory `Map`. On restart — whether a crash, a deploy, or a manual stop — every thread's session ID, agent type, worktree path, and error history evaporates. Users hit their threads again and Junior has no idea who they are. Worktrees stay on disk but lose their binding to a thread.

**Who has this problem:** Operators running Junior in production.
**What happens today:** All sessions reset on restart. Users have to re-run `!build` / `!frontend` to re-bind agent type. `--resume` chains are broken.
**Painful part:** A deploy silently throws away context that only existed in RAM. The home tab was the only place history showed up, and it was wiped too.
**"Finally" moment:** Restart the bot, open the home tab, see every recent thread exactly as it was.

## Full Vision

- File-backed persistence survives restarts.
- Home tab only shows sessions active in the last 2 days — older sessions still stored, just not surfaced on the tab.
- All other consumers (cleanup, health) keep operating on the full set.
- Swappable store (`SessionStore` interface) — in-memory remains a valid option for tests and dev.
- Zero new operational dependencies: no Redis, no external service.

## Dependencies

- Session Management ([session-management.md](session-management.md)) — owns the `ThreadSession` shape this persists.
- Home Tab rendering ([slack/home.ts]) — consumes the windowed query.

## Design

### Why SQLite, not Redis

CLAUDE.md's rule 11 originally named Redis. We reconsidered:

| Concern | Redis | SQLite |
|---|---|---|
| Survives restart | Yes | Yes |
| Operational footprint | Extra service | Zero (file + built-in `bun:sqlite`) |
| Historical queries (home filter) | Manual ZRANGE | `WHERE last_activity > ?` |
| Backups | RDB/AOF config | `cp sessions.db` |
| Write volume at Junior's scale | Fine | Fine (see below) |

Write volume: `updateActivity` and `set` are called on status transitions and turn completions — a handful per human-paced Slack message. No hot path.

### Schema

One row per thread for `sessions`, plus a small `admins` table colocated in the same DB:

```sql
CREATE TABLE sessions (
  thread_id      TEXT PRIMARY KEY,
  json           TEXT NOT NULL,
  last_activity  INTEGER NOT NULL,
  status         TEXT NOT NULL
);
CREATE INDEX idx_sessions_last_activity ON sessions(last_activity);
CREATE INDEX idx_sessions_status ON sessions(status);

-- Additional admins beyond the env-var bootstrap. Added by direct SQL.
-- See thread-commands.md for the gate semantics.
CREATE TABLE admins (
  slack_user_id  TEXT PRIMARY KEY,
  added_at       INTEGER NOT NULL
);
```

- `json` holds the full `ThreadSession` (including ephemeral `pendingMessages` — accepted as stale on restart per rule 11).
- `last_activity` and `status` are denormalized columns for cheap queries (home window, orphan scan).
- No migrations framework for MVP. Any schema change either: 1) adds a nullable column and backfills on read, or 2) nukes the db on a major bump.

PRAGMAs: `journal_mode=WAL`, `synchronous=NORMAL`. Standard for a single-writer SQLite embedded in a Bun server.

### Interface

```typescript
interface SessionStore {
  get(threadId): Promise<ThreadSession | undefined>;
  set(threadId, session): Promise<void>;
  delete(threadId): Promise<void>;
  getAll(): Promise<Map<string, ThreadSession>>;
  getRecent(sinceMs: number): Promise<Map<string, ThreadSession>>;
  updateActivity(threadId): Promise<void>;
  // Slack user IDs of admins beyond the env-var bootstrap. Memory store
  // returns empty; sqlite queries the `admins` table on every call.
  extraAdmins(): Promise<Set<string>>;
}
```

`getRecent(sinceMs)` is the one new method. SQLite filters in the `WHERE` clause; in-memory filters in JS.

### Config

```
SESSION_STORE=sqlite     # memory | sqlite, default sqlite
SESSION_DB_PATH=data/sessions.db
HOME_WINDOW_MS=172800000 # 2 days
```

Factory in `src/session/store/factory.ts` picks the implementation. `config.session.homeWindowMs` is passed to `registerHomeTab`.

## Iterations

### Iteration 0: Interface + in-memory getRecent (~10 min) — DONE

Add `getRecent` to `SessionStore`. Implement on `InMemorySessionStore`. Nothing else changes yet.

**Test:** Unit test — insert sessions with varied `lastActivity`, assert `getRecent` returns only the ones within the window.

### Iteration 1: SqliteSessionStore (~30 min) — DONE

Implement the store. One table, JSON blob, WAL mode.

**Test:** Unit tests round-trip every field, upsert, delete, getRecent, and persistence across instances (close the store, re-open the same file, verify data).

### Iteration 2: Factory and wiring (~15 min) — DONE

Factory reads `config.session.store`. `index.ts` uses the factory. Home tab gets `homeWindowMs` passed through.

**Test:** Boot Junior locally with `SESSION_STORE=sqlite`, send a message, restart, open home tab — session shows. Boot with `SESSION_STORE=memory`, same flow — home is empty after restart.

### Iteration 3: Home tab filter (~5 min) — DONE

`home.ts` calls `store.getRecent(windowMs)` instead of `getAll()`. Cleanup, health, and shutdown keep using `getAll()`.

**Test:** Set `HOME_WINDOW_MS=60000`. Create a session, wait 70s, open home — session gone from tab. Call cleanup — still cleans based on `staleTimeoutMs`.

## Shortcuts

| Shortcut | Replaced in |
|---|---|
| JSON blob, no typed columns for searchable fields beyond `last_activity`/`status` | When we actually need to query by `targetRepo` or `agentType` across all rows |
| No migrations framework — schema changes are additive-only | When we need to break a field |
| WAL files (`sessions.db-wal`, `sessions.db-shm`) live next to the db | Never; this is how SQLite works |
| `pendingMessages` persisted but stale on restart | Never; rule 11 — if the bot restarts, the Claude process is dead and pending messages were meant for it |

## Cut List (true v2)

- Cross-restart session migration (in-memory → sqlite hot swap)
- Encryption at rest (fine for local dev; revisit if we store secrets)
- Read replicas / multi-writer — SQLite is single-writer, which is fine for one Junior process
- Session archival (move >30d sessions to a second table for analytics)
