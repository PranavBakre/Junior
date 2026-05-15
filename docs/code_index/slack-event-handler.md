# Code Index: Slack Event Handler

Slack Bolt app setup, event filtering (with self-bot directive escape hatch), home tab, and file extraction. Posting/formatting live in `stream-to-slack.md` and `thread-context.md`.

## Code Index

### src/slack

| Symbol | File | Purpose |
|---|---|---|
| `createSlackApp(config)` | `app.ts` | Bolt app with Socket Mode + `ignoreSelf: false` (lead's self-bot directives must be observed) |
| `registerEventHandlers(app, onMessage, store?, selfBotId?, selfUserId?, autoTriggerChannels?)` | `events.ts` | Wires `message` + `app_mention` handlers with filtering |
| `isForeignBotThinking(text)` | `events.ts` | Detects sibling Claude bots' streaming "✽ Thinking..." messages — drop those |
| `extractFiles(event)` (private) | `events.ts` | Pulls `{ url_private_download, name, mimetype }` from `event.files` |
| `registerHomeTab(app, store, windowMs)` | `home.ts` | `app_home_opened` listener |
| `publishHomeTab(app, userId, store, windowMs)` | `home.ts` | Builds and publishes the home view |

### Types

| Type | File | Shape |
|---|---|---|
| `SlackMessageEvent` | `events.ts` | `{ threadId, channel, user, text, ts, command, files?, isSelfBot?, botUsername?, dedupeKey? }` |
| `SlackFileAttachment` | `events.ts` | `{ url, name, mimetype }` |
| `OnMessageCallback` | `events.ts` | `(event: SlackMessageEvent) => void` |

## Event Flow

```
Slack WebSocket (Socket Mode)
  │
  ├── message
  │     ├── self-bot check:
  │     │     ├── autoTriggerChannels → let through
  │     │     ├── contains "!<persistent-agent>" line → let through (directive escape hatch)
  │     │     └── else → drop (loop guard)
  │     ├── no text / foreign-bot thinking → drop
  │     ├── derive user (event.user → selfUserId if self-bot → bot_id if auto-trigger)
  │     ├── must be thread reply, DM, or auto-trigger channel
  │     ├── thread + non-auto-trigger + no session in store → drop
  │     ├── stripOwnMention (uses selfUserId)
  │     ├── parseCommand + extractFiles
  │     └── onMessage(SlackMessageEvent)
  │
  └── app_mention
        ├── no user / foreign-bot thinking → drop
        ├── stripOwnMention + parseCommand + extractFiles
        └── onMessage(SlackMessageEvent)
```

## Home Tab (`home.ts`)

Reads `store.getRecent(windowMs)` then renders:

- Summary section (active/idle/draining/errors/muted/total)
- Active sessions list
- Recent idle sessions (top 10 by lastActivity)
- Recent errors (top 5)

Each session block shows status, agent, repo, last-activity, pending count, worktree path, resume command, and any `agentSessions[*]` rows with their own sessionId/status/lastActivity/pending.

## Key Concepts

### Loop prevention + directive escape

Bolt's default `ignoreSelf: true` is disabled so lead's posted `!<agent>` directives are observable. `events.ts` re-enforces the loop guard but lets through self-bot messages in auto-trigger channels OR messages with a `!<persistent-agent>` line.

### Foreign-bot thinking filter

Friday and Doraemon stream "✽ Thinking…" updates. `isForeignBotThinking` drops messages that start with `✽` — they're not user input.

### Session-gated threads

In a thread reply (not DM, not auto-trigger), the handler skips messages whose `thread_ts` has no row in the session store. This prevents random thread chatter from spawning Claude.

### Dedupe via `dedupeKey`

`SlackMessageEvent` carries an optional `dedupeKey`. `AgentDispatcher` sets it per-dispatched-agent so the same Slack message can fan out to multiple persistent agents in parallel without the `seenMessages` cache in `SessionManager` collapsing them.

## Dependencies

- **Uses**: `@slack/bolt`, `SessionStore` (thread-session lookup), `parseCommand`, `support/agents.isPersistentAgent`
- **Used by**: `index.ts` (registration + dispatcher wiring)
