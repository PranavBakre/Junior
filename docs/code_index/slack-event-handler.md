# Code Index: Slack Event Handler

Slack Bolt app setup, event filtering, command parsing, message formatting, response posting, and Home tab rendering.

## Code Index

### src/slack

Event handling, formatting, and Slack API interaction.

| Function | File | Purpose |
|----------|------|---------|
| `createSlackApp(config)` | `app.ts` | Factory: creates Bolt app with socket mode |
| `registerEventHandlers(app, onMessage, store?, selfBotId?)` | `events.ts` | Wires `message` + `app_mention` handlers with filtering |
| `extractFiles(event)` | `events.ts` | Pulls `url_private_download`, `name`, `mimetype` from event attachments |
| `parseCommand(text)` | `commands.ts` | Splits `!build fix auth` → `{ command: "build", text: "fix auth" }` |
| `formatToolStatuses(event)` | `formatting.ts` | Extracts tool names from assistant content blocks |
| `extractAssistantText(event)` | `formatting.ts` | Concatenates text content blocks from assistant events |
| `splitResponse(text, maxLen?)` | `formatting.ts` | Chunks by paragraph/line/code block boundaries (default 3000 chars) |
| `SlackResponder.postResponse(channel, threadTs, text)` | `responder.ts` | Posts response, auto-splits if >3000 chars |
| `SlackResponder.updateStatus(channel, threadTs, text)` | `responder.ts` | Debounced status message (1s min interval) |
| `SlackResponder.deleteStatus(channel, threadTs)` | `responder.ts` | Removes status message when turn completes |
| `SlackResponder.addReaction(channel, ts, emoji)` | `responder.ts` | Adds emoji reaction (e.g., eyes for buffered messages) |
| `registerHomeTab(app, store)` | `home.ts` | Registers `app_home_opened` event |
| `publishHomeTab(app, userId, store)` | `home.ts` | Builds home view with session stats |

### Types

| Type | File | Purpose |
|------|------|---------|
| `SlackMessageEvent` | `events.ts` | `{ threadId, channel, user, text, ts, command, files? }` |
| `SlackFileAttachment` | `events.ts` | `{ url, name, mimetype }` |
| `ParsedCommand` | `commands.ts` | `{ command: string | null, text: string }` |

## Event Flow

```
Slack WebSocket (Socket Mode)
  │
  ├── message event
  │     ├── filter: skip own bot_id (line 31)
  │     ├── filter: must have text + user
  │     ├── filter: must be thread reply OR DM
  │     ├── filter: thread must have active session in store
  │     ├── parseCommand() → extract !command
  │     ├── extractFiles() → SlackFileAttachment[]
  │     └── onMessage(SlackMessageEvent)
  │
  └── app_mention event
        ├── strip <@BOTID> from text
        ├── parseCommand() + extractFiles()
        └── onMessage(SlackMessageEvent)
```

## Key Concepts

### Loop Prevention

`events.ts:31` — `if ("bot_id" in event && selfBotId && event.bot_id === selfBotId) return;`

Messages from the bot MCP server carry Junior's `bot_id` and get filtered. The old Slack plugin sent as the user's OAuth identity (no `bot_id`), bypassing this filter.

### Status Debouncing

`SlackResponder` tracks `lastStatusTime` per thread. Updates within 1s of the last are skipped. This prevents Slack rate limits during rapid tool_use events.

## Dependencies

- **Uses**: `@slack/bolt` (Bolt app, Socket Mode), session store (for thread filtering)
- **Used by**: `SessionManager` (receives `SlackMessageEvent` via callback), `index.ts` (wiring)
