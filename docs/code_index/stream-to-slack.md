# Code Index: Stream to Slack

## Files

| File | Purpose |
|---|---|
| `src/slack/responder.ts` | Posts/updates/deletes Slack messages with debouncing |
| `src/slack/formatting.ts` | Formats Claude events for Slack display |

## Key Exports

### `src/slack/responder.ts`
- `SlackResponder` class:
  - `postResponse(channel, threadTs, text)` — posts response, auto-splits at ~3000 chars using `splitResponse()`
  - `updateStatus(channel, threadTs, text)` — debounced (1s min interval) status message; creates or updates existing status
  - `deleteStatus(channel, threadTs)` — removes status message when turn completes
  - `addReaction(channel, ts, emoji)` — adds reaction (e.g., eyes for buffered messages)

### `src/slack/formatting.ts`
- `formatToolStatuses(event: StreamEvent): string[]` — extracts tool names from `tool_use` content blocks (e.g., "Using Edit", "Using Bash")
- `extractAssistantText(event: StreamEvent): string | null` — concatenates text content blocks from assistant events
- `splitResponse(text, maxLen?): string[]` — intelligent chunking: prefers paragraph breaks, then line breaks, then code block boundaries

## Live Update Flow

```
spawner.onEvent(event)
  │
  ├── assistant event with tool_use
  │     └── formatToolStatuses() → "Using Edit on src/index.ts"
  │           └── responder.updateStatus() → Slack status message
  │
  ├── assistant event with text
  │     └── extractAssistantText() → preview text
  │           └── responder.updateStatus() → Slack status message
  │
  └── result event (turn complete)
        ├── responder.deleteStatus() → remove status
        └── responder.postResponse() → final response (auto-split)
```

## Debouncing

`updateStatus` tracks a `lastStatusTime` per thread. If called within 1s of the last update, the call is skipped. This prevents Slack rate limits from rapid tool_use events (Claude may use 10+ tools in quick succession).
