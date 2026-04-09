# Code Index: Thread Context

Builds the prompt preamble that gives spawned Claude processes identity, channel awareness, and conversation history.

## Code Index

### src/slack + src/persona

| Function | File | Purpose |
|----------|------|---------|
| `buildPromptPreamble(app, channel, threadTs, latestTs, botUserId?)` | `slack/thread-context.ts` | Composes identity + channel + history preamble |
| `resolveChannelName(app, channelId)` | `slack/thread-context.ts` | Cached `conversations.info` lookup |
| `fetchThreadHistory(app, channel, threadTs, latestTs, botUserId?)` | `slack/thread-context.ts` | Fetches thread via `conversations.replies`, formats as labeled messages |
| `loadPersona()` | `persona.ts` | Reads `~/.openclaw/workspace/IDENTITY.md` + `SOUL.md`, caches |
| `downloadSlackFiles(files, threadId, botToken)` | `slack/files.ts` | Downloads image attachments to `/tmp/junior-files/{threadId}/` |

### Types

| Type | File | Purpose |
|------|------|---------|
| `SlackFile` | `slack/files.ts` | `{ localPath, name, mimetype }` |

## Preamble Structure

```xml
<identity>
{persona from SOUL.md + IDENTITY.md}
Your Slack user ID is {botUserId}. Messages from this user ID are yours.
</identity>

<slack-context>
Channel: #channel-name (C123)
Thread: 1234567890.123456
You are responding in this thread. You already have the full thread history below.
Do NOT use Slack search or read tools to find this thread.
</slack-context>

<thread-context>
Junior (you): previous response
User(U123): their message [shared image: screenshot.png]
</thread-context>
```

## Key Concepts

### Caching

- **Channel names**: `Map<channelId, name>` — avoids re-fetching `conversations.info` per message
- **Persona**: loaded once on first call, reused for all sessions

### Image Handling

`downloadSlackFiles()` only downloads image types (png, jpg, gif, webp). Files are saved to `/tmp/junior-files/{threadId}/` and paths are injected into the prompt so Claude can read them natively.

### Thread History Filtering

The current message (`latestTs`) is excluded from history — it's the prompt itself. Bot messages are labeled "Junior (you)", user messages as "User(userId)". @mentions are stripped.

## Dependencies

- **Uses**: `@slack/bolt` (conversations.replies, conversations.info), filesystem (persona files, image downloads)
- **Used by**: `SessionManager.handleMessage()` (composes prompt before spawning)
