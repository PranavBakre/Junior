# Code Index: Process Lifecycle

Timeout guards, graceful shutdown, stale session cleanup, and orphan detection.

## Code Index

### src/lifecycle

| Function | File | Purpose |
|----------|------|---------|
| `withTimeout(handle, timeoutMs)` | `timeout.ts` | Wraps SpawnHandle; kills process + returns error after timeout |
| `setupGracefulShutdown(sessionManager, store)` | `shutdown.ts` | Registers SIGINT/SIGTERM; kills busy sessions, exits within 30s |
| `cleanupStaleSessions(store, staleTimeoutMs)` | `cleanup.ts` | Removes idle/draining sessions older than threshold |
| `checkOrphanedSessions(store)` | `health.ts` | Finds busy sessions whose process died (`kill(pid, 0)` throws) |

## Wiring in `index.ts`

```typescript
// Timeout: applied per-spawn in SessionManager.handleMessage()
withTimeout(spawnHandle, config.claude.timeoutMs)  // default 5 min

// Health checks: every 60s
setInterval(() => checkOrphanedSessions(store), 60_000);

// Stale cleanup: every cleanupIntervalMs (default 15 min)
setInterval(() => cleanupStaleSessions(store, staleTimeoutMs), cleanupIntervalMs);

// Graceful shutdown: on SIGINT/SIGTERM
setupGracefulShutdown(sessionManager, store);
```

## Key Concepts

### Timeout Behavior

On timeout: `handle.kill()` (SIGINT), result becomes `{ exitCode: -1, error: "timeout" }`. The session transitions to idle/error state. No retries — user re-sends.

### Orphan Detection

A session is "orphaned" when `status === "busy"` but `process.kill(pid, 0)` throws (process no longer exists). This can happen if the process crashes without triggering the exit handler. Orphaned sessions are marked idle with `lastError: "orphaned"`.

### Stale Cleanup

Skips `busy` sessions to avoid killing active work. Only removes `idle` and `draining` sessions past the timeout.

## Dependencies

- **Uses**: `session/store` (getAll, set, delete), `claude/types` (SpawnHandle)
- **Used by**: `index.ts` (periodic intervals, shutdown handler), `SessionManager` (timeout wrapping)
