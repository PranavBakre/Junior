# Code Index: Session Management

Core orchestrator: routes Slack messages to Claude, manages the buffer/drain state machine, composes prompts with context, and tracks session state per thread.

## Code Index

### src/session

| Function | File | Purpose |
|----------|------|---------|
| `SessionManager.handleMessage(event)` | `manager.ts` | Main entry: creates/looks up session, handles commands, buffers or spawns |
| `SessionManager.getSession(threadId)` | `manager.ts` | Returns session or undefined |
| `SessionManager.resetSession(threadId)` | `manager.ts` | Clears session state for `!reset` |
| `createSession(threadId, channel)` | `types.ts` | Factory with idle defaults |
| `SessionStore.get(id)` | `store/interface.ts` | Read session by thread ID |
| `SessionStore.set(id, session)` | `store/interface.ts` | Write session |
| `SessionStore.delete(id)` | `store/interface.ts` | Remove session |
| `SessionStore.getAll()` | `store/interface.ts` | List all sessions (for health/cleanup) |
| `InMemorySessionStore` | `store/memory.ts` | Map-based implementation |

### SessionManager Callbacks

Set externally in `index.ts`:

| Callback | When |
|----------|------|
| `onResponse(session, text)` | Claude turn completes with response |
| `onEvent(session, event)` | Each stream-json event (for live status) |
| `onMessageBuffered(event)` | Message buffered while busy |
| `onCommandResponse(event, text)` | Command like `!status` returns text |
| `onError(session, error)` | Spawn fails or times out |

### SessionManager Dependencies

Set externally in `index.ts`:

| Property | Type | Purpose |
|----------|------|---------|
| `agentRouter` | `AgentRouter` | Routes agent type → system prompt |
| `worktreeManager` | `WorktreeManager` | Creates worktrees for code threads |
| `slackApp` | `App` | Used for thread context building |
| `botUserId` | `string` | Identity in prompt preamble |

### Data Model

```typescript
interface ThreadSession {
  threadId: string;
  channel: string;
  sessionId: string | null;        // from Claude's init event
  worktreePath: string | null;
  targetRepo: string | null;
  agentType: string | null;
  status: "idle" | "busy" | "draining";
  pendingMessages: PendingMessage[];
  systemPrompt: string | null;
  verbosity: "normal" | "quiet";
  lastActivity: number;
  createdAt: number;
  errorCount: number;
  lastError: string | null;
  pid: number | null;
}
```

## State Machine

```
idle ──[message]──► busy ──[exit, no pending]──► idle
                      │
                      ├──[message while busy]──► buffer + eyes reaction
                      │
                      └──[exit, has pending]──► draining ──[spawn combined]──► busy
```

## Key Concepts

### Prompt Composition

When spawning Claude, `handleMessage()` builds the prompt in order:

1. `buildPromptPreamble()` — persona + channel metadata + thread history
2. Image paths from `downloadSlackFiles()` appended as `[image: /tmp/junior-files/...]`
3. User message text
4. If draining: combined pending messages as `[user]: text` format

### Buffer Drain

When Claude exits and `pendingMessages.length > 0`, all buffered messages are combined into a single prompt with attribution: `"Multiple messages arrived:\n[alice]: fix the tests\n[bob]: also check the linting"`.

## Dependencies

- **Uses**: `claude/spawner` (spawn), `slack/thread-context` (preamble), `slack/files` (downloads), `agents/router` (system prompts), `worktree/manager` (isolation), `lifecycle/timeout` (guard)
- **Used by**: `index.ts` (event handler callback), `lifecycle/shutdown` (graceful kill), `lifecycle/cleanup` (stale removal)
