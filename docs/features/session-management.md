# Session Management

## Problem

Each Slack thread needs its own Claude Code session — its own conversation history, its own working directory, its own status. When multiple messages arrive in the same thread, the bot needs to know whether Claude is busy (buffer the message) or idle (spawn a new turn). When Claude finishes, buffered messages get drained as a combined prompt.

**Who has this problem:** The bot server — it's the bridge between Slack events and Claude Code processes.
**What happens today:** Nothing — core feature, no predecessor.
**Painful part:** Concurrency. Two messages arrive 500ms apart. The first spawns Claude, the second must be buffered — not spawn a second process. Race conditions between "Claude just exited" and "drain buffer" must be airtight.
**"Finally" moment:** Users send multiple messages while Claude works, get one coherent response addressing everything.

## Full Vision

- Session per thread: `Map<threadId, ThreadSession>`
- Session states: `idle` → `busy` → `draining` → `idle`
- Buffer messages when busy, acknowledge with eyes reaction
- Drain buffer as combined prompt on process exit
- Track session IDs for `--resume` continuity
- Track worktree paths per session (for code-editing threads)
- Track agent type per session (which `.claude/agents/` definition to use)
- Stale session cleanup (24h timeout, warn on uncommitted changes)
- Persistence: in-memory MVP, Redis adapter for production

## Dependencies

- Slack Event Handler (feature: [slack-event-handler.md](slack-event-handler.md)) — produces events
- Claude CLI Spawner (feature: [claude-spawner.md](claude-spawner.md)) — consumes prompts, returns responses

## Data Model

```typescript
interface ThreadSession {
  threadId: string;
  channel: string;
  sessionId: string | null; // Claude Code session ID, null until first response
  worktreePath: string | null; // null for non-code threads
  targetRepo: string | null; // which repo this thread works on
  agentType: string | null; // which .claude/agents/ definition to use
  status: "idle" | "busy" | "draining";
  pendingMessages: Array<{
    user: string;
    text: string;
    ts: string;
    command?: string;
  }>;
  lastActivity: number; // Date.now()
  createdAt: number;
}
```

## State Machine

```
                  new message
    ┌──────────┐ ──────────► ┌──────────┐
    │   idle   │             │   busy   │ ◄── messages buffered here
    └──────────┘ ◄────────── └──────────┘
         ▲       no pending       │
         │                        │ process exits + has pending
         │                   ┌────▼─────┐
         └───────────────────│ draining │ ── spawns new process with combined buffer
                             └──────────┘
```

Transitions:
- `idle` → `busy`: New message arrives, spawn Claude process
- `busy` + message: Buffer it, react with eyes
- `busy` → `idle`: Process exits, no pending messages
- `busy` → `draining`: Process exits, pending messages exist
- `draining` → `busy`: Combined prompt spawned
- `draining` → `idle`: Should not happen (draining always spawns)

## Iterations

### Iteration 0: Single-session proof (~20 min)

Prove session lookup and status tracking works. No real Claude — mock spawner that echoes back after 2s delay.

**What it adds:** Session Map, `handleMessage()` that creates or looks up session, sets status to busy, calls mock spawner, sets status to idle on callback.
**Test:** Send message → session created, status busy. Wait 2s → status idle, response posted. Send second message → same session reused (sessionId preserved).
**Defers:** Buffering, draining, real Claude spawner, worktrees, persistence.

### Iteration 1: Buffer and drain (~1h)

The core concurrency feature. Messages that arrive while Claude is busy get batched into the next turn.

**What it adds:**
- Buffer messages when `status === "busy"`
- React with eyes emoji on buffered messages
- On process exit: check `pendingMessages.length`
  - If 0 → set idle
  - If >0 → set draining, combine as `[user]: text` format, spawn new turn
- Attribution in combined prompt: `"Multiple messages arrived:\n[alice]: fix the tests\n[bob]: also check the linting"`

**Test:** Send message A (spawns Claude). While busy, send message B and C. B and C get eyes reaction. When A finishes, B+C are combined and sent as one prompt. Response addresses both.
**Defers:** Real Claude spawner, worktrees, cleanup, persistence.

### Iteration 2: Agent type and worktree tracking (~30 min)

Sessions track which agent type and worktree to use.

**What it adds:**
- `agentType` field set from slash command (`!build` → `"build"`, `!review` → `"review"`)
- `targetRepo` field (default from config, overridable per thread)
- `worktreePath` field — null initially, set when worktree manager creates one
- Agent type persists across turns — set once, used for all subsequent `--resume` calls
- Can be changed mid-thread with `!build` or `!review` command

**Test:** `!build fix auth` → session has `agentType: "build"`. Next message in same thread → still uses build agent. `!review` in same thread → switches to review agent.
**Defers:** Actual worktree creation (that's worktree manager's job), MCP config.

### Iteration 3: Stale cleanup (~30 min)

Clean up sessions that haven't been active in a while.

**What it adds:**
- `lastActivity` updated on every message
- Background interval (every 15 min) scans all sessions
- Sessions inactive for >24h with no worktree or clean worktree → removed
- Sessions inactive for >24h with dirty worktree → post warning to Slack thread, give 1h grace period, then force remove
- Configurable timeout via env var

**Test:** Create session, don't interact for >24h (or set timeout to 10s for testing). Session gets cleaned up. With dirty worktree → warning posted first.
**Defers:** Redis persistence, graceful shutdown.

### Iteration 4: Persistence adapter (~1h)

Replace in-memory Map with a persistence interface. In-memory stays as default; Redis added as production option.

**What it adds:**
- `SessionStore` interface: `get(threadId)`, `set(threadId, session)`, `delete(threadId)`, `getAll()`, `updateActivity(threadId)`
- `InMemorySessionStore` implements it (wraps the existing Map)
- `RedisSessionStore` implements it (hset/hget with TTL)
- Factory: `createSessionStore(config)` → returns the right implementation
- Pending messages don't need persistence — if bot restarts, Claude process dies with it, user re-sends

**Test:** Switch between in-memory and Redis via config. Sessions survive bot restart with Redis. In-memory still works as before.
**Defers:** Session migration (in-memory → Redis without data loss during hot swap).

## Shortcuts

| Shortcut | Replaced in |
|---|---|
| In-memory Map only | Iteration 4 (Redis) |
| No graceful shutdown (sessions lost on restart) | Iteration 4 |
| Hardcoded 24h timeout | Iteration 3 (env var) |
| No session metrics/logging | Post-MVP |

## Cut List (true v2)

- Session transfer between threads (move a session to a new thread)
- Session forking (branch a conversation into two threads)
- Session replay (re-run a session's prompts for debugging)
- Multi-bot sessions (multiple Claude instances per thread)
- Priority queue for buffered messages (urgent messages skip the line)
