# Code Index: Session Management

## Files

| File | Purpose |
|---|---|
| `src/session/manager.ts` | Core orchestrator: routes messages, manages state machine, composes prompts |
| `src/session/types.ts` | Session data types and factory |
| `src/session/store/interface.ts` | Storage interface (get/set/delete/getAll) |
| `src/session/store/memory.ts` | In-memory Map implementation |

## Key Exports

### `src/session/manager.ts`
- `SessionManager` class:
  - `handleMessage(event: SlackMessageEvent)` — main entry: creates/looks up session, handles commands, buffers or spawns
  - `getSession(threadId): ThreadSession | undefined`
  - `resetSession(threadId)` — clears session state for `!reset`
  - `agentRouter` — set externally, routes agent type to system prompt
  - `worktreeManager` — set externally, creates/checks worktrees
  - `slackApp` — set externally, used for thread context building
  - `botUserId` — set externally, used for identity in prompt preamble
  - Callbacks: `onResponse`, `onEvent`, `onMessageBuffered`, `onCommandResponse`, `onError`

### `src/session/types.ts`
- `ThreadSession` — `{ threadId, channel, sessionId, worktreePath, targetRepo, agentType, status, pendingMessages, systemPrompt, verbosity, lastActivity, createdAt, errorCount, lastError, pid }`
- `SessionStatus` — `"idle" | "busy" | "draining"`
- `PendingMessage` — `{ user, text, ts, command? }`
- `createSession(threadId, channel): ThreadSession` — factory with defaults

### `src/session/store/interface.ts`
- `SessionStore` interface: `get(id)`, `set(id, session)`, `delete(id)`, `getAll()`, `updateActivity(id)`

### `src/session/store/memory.ts`
- `InMemorySessionStore` — wraps `Map<string, ThreadSession>`

## State Machine

```
idle ──[message]──► busy ──[exit, no pending]──► idle
                      │
                      ├──[message while busy]──► buffer + eyes reaction
                      │
                      └──[exit, has pending]──► draining ──[spawn combined]──► busy
```

## Prompt Composition

When spawning Claude, `SessionManager.handleMessage()` builds the prompt:

1. `buildPromptPreamble()` — persona + channel metadata + thread history
2. Image paths from `downloadSlackFiles()` appended as `[image: /tmp/junior-files/...]`
3. User message text
4. If draining: combined pending messages as `[user]: text` format
