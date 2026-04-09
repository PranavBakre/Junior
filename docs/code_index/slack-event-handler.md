# Code Index: Slack Event Handler

## Files

| File | Purpose |
|---|---|
| `src/slack/app.ts` | Factory: creates Bolt app with socket mode |
| `src/slack/events.ts` | Registers `message` and `app_mention` handlers, filters events, routes to callback |
| `src/slack/commands.ts` | Parses `!command` prefix from message text |
| `src/slack/formatting.ts` | Formats tool statuses and chunks long responses for Slack |
| `src/slack/responder.ts` | Posts, updates, deletes Slack messages with debounced status updates |
| `src/slack/home.ts` | Publishes Home tab with active session stats |

## Key Exports

### `src/slack/app.ts`
- `createSlackApp(config: Config): App` — creates Bolt app with `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN`

### `src/slack/events.ts`
- `registerEventHandlers(app, onMessage, store?, selfBotId?)` — wires `message` + `app_mention` events
- `SlackMessageEvent` — normalized event type: `{ threadId, channel, user, text, ts, command, files? }`
- `SlackFileAttachment` — `{ url, name, mimetype }`

### `src/slack/commands.ts`
- `parseCommand(text): ParsedCommand` — splits `!build fix auth` into `{ command: "build", text: "fix auth" }`

### `src/slack/formatting.ts`
- `formatToolStatuses(event): string[]` — extracts tool names from assistant events
- `extractAssistantText(event): string | null` — pulls text content blocks
- `splitResponse(text, maxLen): string[]` — chunks by paragraph/line/code block boundaries

### `src/slack/responder.ts`
- `SlackResponder` class:
  - `postResponse(channel, threadTs, text)` — posts (auto-splits if >3000 chars)
  - `updateStatus(channel, threadTs, text)` — debounced status message (1s min interval)
  - `deleteStatus(channel, threadTs)` — removes status message
  - `addReaction(channel, ts, emoji)` — adds emoji reaction

### `src/slack/home.ts`
- `registerHomeTab(app, store)` — registers `app_home_opened` event
- `publishHomeTab(app, userId, store)` — builds and publishes home view

## Event Flow

```
Slack WebSocket (Socket Mode)
  │
  ├── message event
  │     ├── filter: skip own bot_id (line 31)
  │     ├── filter: must have text + user
  │     ├── filter: must be thread reply OR DM
  │     ├── filter: thread must have active session in store
  │     ├── parse command (parseCommand)
  │     ├── extract files (extractFiles)
  │     └── onMessage(SlackMessageEvent)
  │
  └── app_mention event
        ├── strip <@BOTID> from text
        ├── parse command
        ├── extract files
        └── onMessage(SlackMessageEvent)
```

## Loop Prevention

`events.ts:31` — `if ("bot_id" in event && selfBotId && event.bot_id === selfBotId) return;`

This is why the bot MCP server (sends as bot) works but the Slack plugin (sends as user) caused loops.
