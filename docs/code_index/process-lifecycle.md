# Code Index: Process Lifecycle

Timeout guards, graceful shutdown, stale session cleanup, orphan detection, and dev-server slot management.

## Code Index

### src/lifecycle

| Symbol | File | Purpose |
|---|---|---|
| `withTimeout(handle, timeoutMs, onTimeout?)` | `timeout.ts` | Wraps `SpawnHandle`; kills + resolves with `error: "Process timed out..."` after timeout |
| workflow runner idle recovery | `src/workflows/executor.ts` | For workflow runner configs with `idleTimeoutMs`, sends SIGINT after a silent period, SIGKILL after 10s grace if needed, then respawns with provider-native resume and a continuation prompt up to `maxIdleInterrupts`. |
| `setupGracefulShutdown(manager, store, devServerManager?)` | `shutdown.ts` | SIGINT/SIGTERM handler — `resetSession` busy threads, `killAll` dev servers, hard exit after 30s |
| `cleanupStaleSessions(store, staleTimeoutMs)` | `cleanup.ts` | Deletes stale idle sessions; skips top-level busy/draining and rows with any busy persistent agent |
| `checkOrphanedSessions(store)` | `health.ts` | Marks `busy` sessions/agents idle when their pid is dead. Scans top-level pid + every `agentSessions[*].pid`. |
| `isPidAlive(pid)` | `process-utils.ts` | `process.kill(pid, 0)` returns true if ESRCH not thrown |
| `isPortHeld(port)` | `process-utils.ts` | Non-blocking TCP connect probe on `127.0.0.1:<port>`, 3s timeout |
| `DevServerManager` | `dev-server.ts` | Per-repo dev-server lifecycle: spawn, branch switch via `git fetch + reset --hard`, readiness probe, idle TTL sweep, kill (SIGINT → SIGKILL with 5s grace) |
| `DevServerManager.bootstrap()` | `dev-server.ts` | At startup: ensure dev-server worktree exists, write `.git/info/exclude` to hide lock files, self-heal legacy `.gitignore` overwrite, scan port for external listeners |
| `DevServerQueue` | `dev-server-queue.ts` | Per-repo `proper-lockfile` serialization on top of `DevServerManager`; writes `.lock.meta.json` (holder) + `.queue` (NDJSON waiters); `acquire/release/readQueueDepth/stealStale/kill` |

### Types

| Type | File | Shape |
|---|---|---|
| `DevServerState` | `dev-server.ts` | `{ pid, branch, startedAt, lastUsedAt }` |
| `DevServerInfo` | `dev-server.ts` | `{ pid, port, readyUrl }` |
| `HolderMeta` | `dev-server-queue.ts` | `{ holderThreadId, holderPid, branch, acquiredAt }` |
| `WaiterMeta` | `dev-server-queue.ts` | `{ threadId, branch, enqueuedAt }` |
| `QueueDepth` | `dev-server-queue.ts` | `{ holder, waiters[] }` |
| `AcquireResult` | `dev-server-queue.ts` | `{ release, info }` |

## Wiring in `index.ts`

```typescript
withTimeout(handle, config.claude.timeoutMs)                            // per-spawn, in SessionManager
setInterval(() => checkOrphanedSessions(store), 60_000);                // health
setInterval(() => cleanupStaleSessions(store, staleTimeoutMs), interval); // cleanup
setupGracefulShutdown(sessionManager, store, devServerManager);
devServerManager.bootstrap();  // ensures dev-server worktrees + port scan
```

## Key Concepts

### Timeout behavior

On timeout: `handle.kill()`, result resolves with `{ exitCode: null, error: "Process timed out after Xms" }`. Session transitions back to idle. No retries — user re-sends.

### Orphan detection

A session/agent is "orphaned" when `status === "busy"` but `process.kill(pid, 0)` throws. `health.ts` walks both the top-level `session.pid` and every `agentSessions[*].pid`, marking each idle and recording `lastError: "orphaned"` on the parent session.

### Stale cleanup

Skips top-level `busy` and `draining` sessions to avoid killing active work. Also skips rows where any `agentSessions[*].status === "busy"`, because the parent thread can be idle while a worker is still running. Only removes idle rows past `staleTimeoutMs` (default 24h) when all worker sessions are terminal/non-busy.

### Dev-server queue serialization

`DevServerManager.ensure()` is NOT safe to call concurrently per repo — two parallel calls both miss the reuse branch and both spawn. `DevServerQueue.acquire()` wraps it with `proper-lockfile` (per-repo lock under the dev-server worktree directory). The `onCompromised` handler is synchronous (proper-lockfile won't await it) and fires `stealStale` to kill the orphan PID this caller is responsible for.

### `expectedOrphanPid` race guard

`stealStale(repoName, expectedOrphanPid)` only kills if the manager's tracked PID matches what this caller spawned. Without this, an `onCompromised` firing after another acquire has stolen the lock and replaced the server would kill the freshly-started PID.

## Dependencies

- **Uses**: `session/store`, `claude/types`, `proper-lockfile`, `worktree/manager`, `node:net` (port probe), `Bun.spawn` (git, dev-command)
- **Used by**: `index.ts` (intervals + shutdown), `SessionManager` (timeout wrapping), `support/router` (`!devserver` handler)
