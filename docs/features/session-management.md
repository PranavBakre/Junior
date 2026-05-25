# Session Management

## Problem

Each Slack thread is one `ThreadSession`, but a single thread can run several persistent agents concurrently (lead, reproducer, thinker, build, reviewer, …). The manager owns:

- Per-thread lookup and creation
- Per-agent run state, sessionId, pending buffer, pid
- Buffer-on-busy / drain-on-exit semantics, applied independently per agent
- Slash-command handling (see [thread-commands.md](thread-commands.md))
- Spawn orchestration (see [claude-spawner.md](claude-spawner.md)) and event fan-out (see [stream-to-slack.md](stream-to-slack.md))

## Shape

```
ThreadSession                                 // one row per thread
├── sessionId / leadSessionId                 // top-level (lead | default Junior)
├── pendingMessages / status / pid            // top-level buffer + state machine
├── agentSessions: Record<name, AgentSession> // every other persistent agent
│     └── { sessionId, status, pendingMessages, pid, lastActivity }
├── worktreePath / worktreePaths              // single vs. multi-repo (bug pipeline)
├── targetRepo / baseRef
├── agentType / defaultAgent                  // !build/!review/... and !agent override
├── verbosity / muted / model / cwd
└── lastError / lastActivity / createdAt
```

`AgentSession.status`: `idle | busy | done | failed`.
`ThreadSession.status` (top-level only): `idle | busy | draining`.

See [persistent-agents.md](persistent-agents.md) for the agent substrate, [agent-routing.md](agent-routing.md) for how agent names resolve to definitions.

## Routing

- `handleMessage` → top-level run with `agentName = "default"`
- `handleLeadMessage` → top-level run with `agentName = "lead"` (shares `leadSessionId`)
- `handleAgentMessage(name)` → per-agent run via `agentSessions[name]`; `"lead"`/`"default"` are short-circuited back to the top-level path

Top-level (`lead` / `default`) uses `session.sessionId` + `session.pendingMessages`. Workers use their `AgentSession` slice. Dedupe is per `(ts, agentName)` for workers, per `ts` for top-level.

## State Machine (per agent)

```
              new message
   ┌───────┐ ───────────► ┌──────┐
   │ idle  │              │ busy │ ◄── messages buffered here
   └───────┘ ◄─────────── └──────┘
       ▲   no pending        │
       │                     │ process exits
       │                ┌────▼──────┐
       └────────────────│ draining* │
                        └───────────┘
*top-level only; workers re-enter busy directly with the combined prompt.
Worker terminal states: done (clean) | failed (spawn/setup error).
```

- New message + idle → mark busy, spawn, persist.
- New message + busy → push to that agent's `pendingMessages`, fire `onMessageBuffered`, persist.
- On exit: refetch session (long-running agents go stale; concurrent agents may have written), drain that agent's buffer as `"[user]: text"` lines, or settle to terminal state. If the thread was muted mid-turn, discard the buffer.
- `!cancel` kills every handle keyed under the thread and zeroes all buffers/pids.
- `!reset <agent>` kills only that agent's handle and clears its slice; `!reset all` deletes the row. Run completions check ownership of `handles[threadId:agentName]` before writing — a discarded run never clobbers state or posts to Slack.

## Spawn Composition

For every run the manager:

1. Creates a worktree if `targetRepo` is set and one doesn't exist (always, not just for `build`/`frontend`). Failure clears `targetRepo` for the run so cwd never lands in the shared origin repo.
2. Resolves the agent definition to pick a context profile (see [agent-routing.md](agent-routing.md)).
3. Builds the prompt: full preamble (workspace, thread context, persistent-agent state, image paths) on the first turn; on resumed turns only the workspace block, gated by the agent's context profile. `--resume` carries identity/history.
4. Composes the system prompt: agent definition + per-agent Slack identity (`username`, `icon_emoji`, attribution suffix) + dispatch allow-list (which `!<agent>` directives this agent may emit).
5. Spawns through the selected runner provider, stores the handle under `threadId:agentName`, wires `onEvent` → status pills / streaming, `result.then` → `onRunComplete`.

For headless CLI providers that Junior owns, silent runs are interrupted after `SESSION_IDLE_TIMEOUT_MS` and retried with provider-native continuity when a session id has already been captured. OpenCode uses this path only when `OPENCODE_CONTINUITY_ENABLED=true`; otherwise Junior must not SIGINT/retry because the retry would start a fresh OpenCode session.

## Persistence

`SessionStore` interface (`src/session/store/interface.ts`): `get`, `set`, `delete`, `getAll`, `getRecent(sinceMs)`, `updateActivity`, `extraAdmins`. Two implementations:

- `InMemorySessionStore` — tests / `SESSION_STORE=memory`
- `SqliteSessionStore` — production (`bun:sqlite`, `data/sessions.db`, override via `SESSION_DB_PATH`)

Factory in `store/factory.ts`. Pending messages are persisted but stale on restart — the Claude process they were queued behind is dead.

Admins: bootstrap one in `ADMIN_SLACK_USER_ID`; the rest live in the `admins` SQLite table and surface via `extraAdmins()`. Open mode (everyone admin) only when both tiers are empty.

## Observability

- Per-agent status pills stream via `onEvent` (see [stream-to-slack.md](stream-to-slack.md)).
- HTTP dashboard reads `getRecent` and surfaces `defaultAgent` + `agentSessions`.
- `!status` prints status, muted, agentType, defaultAgent, repo, worktree, last activity, pending count.

## Cleanup

Stale threads / worktrees are reaped by the lifecycle module — see [process-lifecycle.md](process-lifecycle.md). Cleanup skips rows with any busy persistent agent so an idle top-level thread is not deleted while a worker is still running. The home tab windows on `HOME_WINDOW_MS` (2 days default) via `getRecent`.
