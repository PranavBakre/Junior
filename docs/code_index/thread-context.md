# Code Index: Thread Context

## Files

| File | Purpose |
|---|---|
| `src/slack/thread-context.ts` | Builds prompt preamble with persona, channel info, and thread history |
| `src/persona.ts` | Loads Junior's identity from openclaw workspace files |
| `src/slack/files.ts` | Downloads Slack image attachments to local filesystem |

## Key Exports

### `src/slack/thread-context.ts`
- `buildPromptPreamble(app, channel, threadTs, latestTs, botUserId?): string`
  - Fetches persona, channel name, and thread history in parallel
  - Builds XML-tagged sections: `<identity>`, `<slack-context>`, `<thread-context>`
  - Excludes the current message (`latestTs`) from history
  - Strips @mentions from message text
  - Labels bot messages as "Junior (you)" and user messages as "User(userId)"

### `src/persona.ts`
- `loadPersona(): Promise<string>` — reads `~/.openclaw/workspace/IDENTITY.md` and `SOUL.md`, caches result

### `src/slack/files.ts`
- `downloadSlackFiles(files, threadId, botToken): Promise<SlackFile[]>`
  - Downloads to `/tmp/junior-files/{threadId}/`
  - Returns `{ localPath, name, mimetype }` for each file
  - Only downloads image types (png, jpg, gif, webp)

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
The following is the Slack thread history leading up to the current message.
Use this to understand the conversation so far. Respond ONLY to the current message below.

Junior (you): previous response
User(U123): their message [shared image: screenshot.png]
</thread-context>
```

## Caching

- Channel name cache: `Map<channelId, channelName>` — avoids re-fetching `conversations.info` per message
- Persona cache: loaded once on first call, reused for all subsequent calls
