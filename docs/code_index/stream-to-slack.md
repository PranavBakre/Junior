# Code Index: Stream to Slack

Formats Claude stream events as Slack status messages, posts final responses (with sentinel handling), and parses the underlying stream-json.

## Code Index

### src/slack/responder.ts

| Symbol | Purpose |
|---|---|
| `SlackResponder(app)` | Constructor — holds a `Map<key, StatusEntry>` of live status messages keyed by `${threadTs}:${agentName}` |
| `postResponse(channel, threadTs, text, identity?)` | Posts the final reply; auto-splits with `splitResponse`; optional `username` + `icon_emoji` for per-agent identity |
| `updateStatus(channel, threadTs, text, agentName = "lead")` | First call posts a new status message; subsequent calls `chat.update` with a 1s debounce per `(thread, agent)` |
| `deleteStatus(channel, threadTs, agentName = "lead")` | `chat.delete` when the turn completes |
| `addReaction(channel, messageTs, emoji)` | `reactions.add` (used for `eyes` buffer ack, `x` admin-denied) |

### src/slack/formatting.ts

| Symbol | Purpose |
|---|---|
| `formatToolStatuses(event)` | Extracts `tool_use` blocks from an assistant event; renders each with tool-specific formatting (Bash → first 80 chars of command, Read/Edit/Write → file_path, Grep/Glob → pattern, Task → subagent_type, multi-Task → aggregated "Calling X, Y (N in progress)") |
| `extractAssistantText(event)` | Concatenates all `text` content blocks from an assistant event |
| `prepareSlackResponse(text)` | Sentinel handler: returns null for empty/`NO_SLACK_MESSAGE`/trailing-only-sentinel; strips trailing sentinel from real content |
| `splitResponse(text, maxLength = 4000)` | Chunks long responses; prefers paragraph (`\n\n`) → line → code-block boundaries; avoids splitting inside fenced code blocks |
| `NO_SLACK_MESSAGE` | Sentinel constant — agents return this to skip Slack post |

### src/claude/parser.ts

| Symbol | Purpose |
|---|---|
| `createStreamParser()` | Returns `{ feed(chunk): StreamEvent[] }`. Buffers partial lines, JSON-parses, validates shape via `isStreamEvent`, silently skips malformed/unknown |

## Live Update Flow

```
spawner.onEvent(event)
  │
  ├── system+init               → log session start
  │
  ├── assistant + text content  → extractAssistantText → prepareSlackResponse
  │                                 ├── null → log + suppress
  │                                 └── text → responder.updateStatus(..., agentName)
  │
  ├── assistant + tool_use      → formatToolStatuses → updateStatus(... per status)
  │
  └── result (turn done) — onRunComplete:
        ├── deleteStatus(channel, thread, agentName)
        ├── prepareSlackResponse(response)
        │     ├── null → log "response suppressed"
        │     └── text → postResponse(channel, thread, text, session.slackIdentity)
        └── continue drain if pending
```

## Key Concepts

### Sentinel handling

Agents that decide a turn doesn't warrant a reply return exactly `NO_SLACK_MESSAGE`. `prepareSlackResponse` also strips a trailing sentinel from real content (agent intended to reply and habitually appended the sentinel). Both `onResponse` and `onEvent`'s status path run through it.

### Per-agent status keys

`updateStatus`/`deleteStatus` key by `${threadTs}:${agentName}` so multi-agent threads (bug pipeline, etc.) each have their own status message. Default `agentName` is `"lead"` for backwards compatibility.

### Debouncing

1-second minimum between `chat.update` calls per key. Drops updates within the window; bot can emit 10+ `tool_use` events per second.

### Response splitting

`splitResponse` (default 4000 chars) tries paragraph → line → code-fence boundaries. Inside a code block (odd ``` count in slice), it searches for the closing fence and splits after it (within 1.5x maxLength). Falls back to hard split.

### Stream parser shape validation

Accepts `system+init`, `assistant` (with content array), `result`, `user`, `rate_limit_event`. Anything else is silently dropped — forward-compatible with new event types.

## Dependencies

- **Uses**: `@slack/bolt` (`chat.postMessage`, `chat.update`, `chat.delete`, `reactions.add`), `claude/types`
- **Used by**: `SessionManager.onEvent`/`onResponse`/`onError` wiring in `index.ts`
