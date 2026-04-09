# Code Index: Process Lifecycle

## Files

| File | Purpose |
|---|---|
| `src/lifecycle/timeout.ts` | Wraps spawn handles with a kill-on-timeout guard |
| `src/lifecycle/shutdown.ts` | Graceful SIGINT/SIGTERM handler |
| `src/lifecycle/cleanup.ts` | Removes stale idle sessions |
| `src/lifecycle/health.ts` | Detects busy sessions whose processes have died |

## Key Exports

### `src/lifecycle/timeout.ts`
- `withTimeout(handle: SpawnHandle, timeoutMs: number): SpawnHandle`
  - Returns a wrapped handle that kills the process after `timeoutMs`
  - On timeout: `handle.kill()`, result becomes `{ exitCode: -1, error: "timeout" }`
  - Clears timeout on normal exit

### `src/lifecycle/shutdown.ts`
- `setupGracefulShutdown(sessionManager, store)`
  - Registers `SIGINT` and `SIGTERM` handlers
  - On signal: iterates all busy sessions, kills their processes
  - Waits up to 30s for cleanup, then `process.exit()`

### `src/lifecycle/cleanup.ts`
- `cleanupStaleSessions(store, staleTimeoutMs): Promise<string[]>`
  - Scans all sessions via `store.getAll()`
  - Removes sessions where `Date.now() - lastActivity > staleTimeoutMs` AND status is not `busy`
  - Returns array of cleaned thread IDs

### `src/lifecycle/health.ts`
- `checkOrphanedSessions(store): Promise<string[]>`
  - Finds busy sessions whose process no longer exists (`process.kill(pid, 0)` throws)
  - Marks them idle with `lastError: "orphaned"`
  - Returns array of orphaned thread IDs

## Wiring in `index.ts`

```typescript
// Periodic health checks (every 60s)
setInterval(() => checkOrphanedSessions(store), 60_000);

// Stale cleanup (every cleanupIntervalMs, default 15 min)
setInterval(() => cleanupStaleSessions(store, staleTimeoutMs), cleanupIntervalMs);

// Graceful shutdown
setupGracefulShutdown(sessionManager, store);
```

Timeout is applied in `SessionManager.handleMessage()` when spawning Claude via `withTimeout(spawnHandle, config.claude.timeoutMs)`.
