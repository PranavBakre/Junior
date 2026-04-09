# Code Index: Stream to Slack

Formats Claude stream events as Slack status messages and posts final responses.

## Code Index

### src/slack

| Function | File | Purpose |
|----------|------|---------|
| `formatToolStatuses(event)` | `formatting.ts` | Extracts tool names from `tool_use` content blocks (e.g., "Using Edit") |
| `extractAssistantText(event)` | `formatting.ts` | Concatenates text content blocks from assistant events |
| `splitResponse(text, maxLen?)` | `formatting.ts` | Chunks by paragraph → line → code block boundaries (default 3000) |
| `SlackResponder.postResponse(channel, threadTs, text)` | `responder.ts` | Posts final response, auto-splits if long |
| `SlackResponder.updateStatus(channel, threadTs, text)` | `responder.ts` | Debounced live status message |
| `SlackResponder.deleteStatus(channel, threadTs)` | `responder.ts` | Removes status when turn completes |

## Live Update Flow

```
spawner.onEvent(event)
  │
  ├── assistant + tool_use  → formatToolStatuses() → updateStatus()
  ├── assistant + text      → extractAssistantText() → updateStatus()
  └── result (turn done)    → deleteStatus() + postResponse()
```

## Key Concepts

### Response Splitting

`splitResponse()` tries breaks in order: paragraph boundary (`\n\n`), line boundary (`\n`), code block boundary. Falls back to hard split at `maxLen` if none found. This prevents cutting mid-code-block.

### Debouncing

`updateStatus` skips calls within 1s of the last update per thread. Prevents Slack rate limits during rapid tool_use sequences (Claude may invoke 10+ tools in quick succession).

## Dependencies

- **Uses**: `@slack/bolt` (chat.postMessage, chat.update, chat.delete, reactions.add), `claude/types` (StreamEvent)
- **Used by**: `index.ts` (wires `sessionManager.onEvent` → responder)
