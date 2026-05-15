# Code Index: Session Management

Core orchestrator: routes Slack messages to Claude, manages the buffer/drain state machine (per-thread for lead/default, per-agent for workers), composes prompts with context, dispatches slash commands, and tracks session state.

## Code Index

### src/session

| Symbol | File | Purpose |
|---|---|---|
| `SessionManager(store, config, spawnClaude?)` | `manager.ts` | Constructor — `spawnClaude` injectable for tests |
| `handleMessage(event)` | `manager.ts` | Default single-session entry — any-channel @mentions |
| `handleLeadMessage(event)` | `manager.ts` | Single-session entry for the support `lead` agent (shares top-level session slot) |
| `handleAgentMessage(event, agentName)` | `manager.ts` | Persistent-agent entry — per-agent buffer/drain via `session.agentSessions[name]` |
| `getSession(threadId)` | `manager.ts` | Read accessor |
| `resetSession(threadId)` | `manager.ts` | Kills handles for the thread, deletes the row |
| `resetAgent(threadId, agentName)` | `manager.ts` | Resets one agent slice (`lead`/`default` clear top-level fields; others clear `agentSessions[name]`) |
| `isAdmin(userId)` | `manager.ts` | Env bootstrap admin + `extraAdmins` from store. Open-mode only when both tiers are empty. |
| `createSession(threadId, channel, defaultVerbosity?)` | `types.ts` | Factory with idle defaults |

### SessionManager callbacks (wired in `index.ts`)

| Callback | When |
|---|---|
| `onResponse(session, text)` | Claude turn complete; `prepareSlackResponse` runs sentinel handling |
| `onEvent(session, event)` | Each stream-json event (status updates) |
| `onMessageBuffered(event)` | Message buffered while busy → `eyes` reaction |
| `onCommandResponse(event, text)` | Command (`!status`, `!help`, etc.) returns text |
| `onReaction(event, emoji)` | Used for admin-denied commands (`x` reaction) |
| `onError(session, error)` | Spawn fails or times out |

### SessionManager dependencies

`agentRouter`, `worktreeManager`, `slackApp`, `botUserId` — assigned externally in `index.ts`.

### Data Model

```typescript
interface ThreadSession {
  threadId: string;
  channel: string;
  sessionId: string | null;                // current run's session ID
  leadSessionId: string | null;            // pinned to lead's resume target across re-routes
  agentSessions: Record<string, AgentSession>;  // per-worker state
  worktreePath: string | null;             // single-repo flow
  worktreePaths: Record<string, string>;   // multi-repo (bug pipeline)
  targetRepo: string | null;
  baseRef: string | null;
  agentType: string | null;
  systemPrompt: string | null;
  activeAgentName?: string;                // run-scoped, set by buildRunSession
  slackIdentity?: AgentIdentity;           // run-scoped
  status: "idle" | "busy" | "draining";
  pendingMessages: PendingMessage[];
  verbosity: "quiet" | "normal" | "verbose";
  muted: boolean;
  model: string | null;
  cwd: string | null;                       // utility-command override
  pid: number | null;
  lastActivity: number; createdAt: number;
  lastError: { type, message, timestamp } | null;
  defaultAgent?: "junior" | "lead" | null;  // thread-level !agent override
}

interface AgentSession {
  agentName: string;
  sessionId: string | null;
  status: "idle" | "busy" | "done" | "failed";
  pendingMessages: PendingMessage[];
  lastActivity: number;
  pid: number | null;
}
```

## State Machine

**Top-level** (`lead`/`default` agents — share `session.{status, sessionId, pendingMessages}`):

```
idle ──[msg]──► busy ──[exit, no pending]──► idle
                  ├──[msg while busy]──► buffer (eyes reaction)
                  └──[exit, pending]──► draining ──[combined drain]──► busy
```

**Per-agent** (workers — each `agentSessions[name]` is independent):

```
idle ──[msg]──► busy ──[exit, no pending]──► done|failed
                  ├──[msg while busy]──► buffer (eyes reaction)
                  └──[exit, pending]──► busy (combined drain stays in 'busy')
```

## Commands

Handled in `handleCommand`: `build`, `frontend`, `architect` (set `agentType`, continue), `repo`, `branch`, `agent`, `cancel`, `reset` (admin), `status`, `help`, `quiet`/`normal`/`verbose`, `adhoc`/`bugs` (calendar tasks via haiku + cwd override), `mute`/`unmute` (admin). See `thread-commands.md`.

## Prompt Composition (in `runClaudeWithAgent`)

1. Resolve target repo + (always) create worktree if `targetRepo` set
2. Resolve agent definition + context profile (defaults to all-true)
3. First turn: `buildPromptPreamble(...)` injects enabled blocks
4. Resumed turn: just `buildWorkspaceBlock` (cheap safety insurance) if workspace flag is on
5. `resolveSlackMentions` rewrites `<@U…>` → `@Name (<@U…>)`
6. Download image files → append paths
7. `composeSystemPrompt` (common + agent body) + identity block + dispatch-allow block → `session.systemPrompt`
8. Optional `<persistent-agent-state>` block when `context.agentState` is on
9. `spawnClaude(runSession, prompt, ..., agentIdentity)` wrapped in `withTimeout`

## Concurrency Guards

- **Refetch-then-mutate in `onRunComplete`**: long-running agents may be minutes stale; refetch the row to avoid clobbering writes from other agents on the same thread.
- **Handle ownership check**: if `this.handles.get(handleKey) !== ownHandle`, the run was replaced by `!reset` or a newer spawn — bail without writing or posting.
- **`seenMessages` dedupe**: bounded set (cap 1000, drops oldest 500) keyed on `dedupeKey ?? ts`. Slack fires both `message` and `app_mention` for @mentions.

## Dependencies

- **Uses**: `claude/spawner`, `lifecycle/timeout`, `slack/thread-context` (preamble, mention resolution), `slack/files` (image download), `agents/router`, `agents/loader` (context profile), `worktree/manager`, `support/agents` (identity, dispatch-allow), `session/store`
- **Used by**: `support/router` (`AgentDispatcher` routes here), `index.ts` (wiring), `lifecycle/shutdown` + `lifecycle/cleanup`
