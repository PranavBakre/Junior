# Thread Context & Claude Instance Awareness

## Problem

When Junior spawns a `claude -p` process, that process has zero knowledge of the Slack conversation it's responding to. It doesn't know its own name, can't see prior messages in the thread, can't see images users shared, and has no way to send files back. `--resume` gives Claude its own conversation history, but not the Slack thread's.

**Who has this problem:** Every spawned Claude instance — they respond in a vacuum without thread context.
**Painful part:** Without context, Claude hallucinates thread history, doesn't recognize other bots' messages, and gives generic responses to thread-specific questions.
**"Finally" moment:** Claude knows it's Junior, sees the full thread history (including images), and can upload screenshots back to Slack.

## What It Does

Before every Claude spawn, the session manager builds a prompt preamble with:

1. **Identity** — Junior's persona (SOUL.md + IDENTITY.md from `~/.openclaw/workspace/`)
2. **Bot user ID** — so Claude recognizes its own messages in thread history
3. **Channel & thread metadata** — channel name, thread_ts, with instruction not to search Slack
4. **Thread history** — all prior messages fetched via `conversations.replies`, labeled by role
5. **Image attachments** — downloaded to `/tmp/junior-files/<threadId>/`, paths appended to prompt
6. **Historical file annotations** — `[shared image: filename.png]` in thread history

## Architecture

```
Slack message arrives
    │
    ▼
SessionManager.handleMessage()
    │
    ├── buildPromptPreamble()          ← thread-context.ts
    │     ├── loadPersona()            ← persona.ts (cached after first load)
    │     ├── resolveChannelName()     ← cached per channel
    │     └── fetchThreadHistory()     ← conversations.replies API
    │
    ├── downloadSlackFiles()           ← files.ts (images only)
    │
    ▼
prompt = preamble + file paths + user message
    │
    ▼
spawnClaude(session, prompt, config, cwd, botToken)
    │
    env: SLACK_CHANNEL, SLACK_THREAD_TS, SLACK_BOT_TOKEN
    │
    ▼
Claude can upload files back via bin/slack-upload.sh
```

## Key Files

| File | Purpose |
|---|---|
| `src/slack/thread-context.ts` | Builds prompt preamble: identity, channel metadata, thread history |
| `src/persona.ts` | Loads SOUL.md + IDENTITY.md from openclaw workspace (cached) |
| `src/slack/files.ts` | Downloads Slack image attachments to local disk |
| `src/slack/events.ts` | Extracts file attachments from Slack events |
| `src/claude/spawner.ts` | Passes SLACK_CHANNEL/THREAD_TS/BOT_TOKEN env vars |
| `bin/slack-upload.sh` | Uploads files to Slack thread (uses env vars) |
| `.mcp.json` | Playwright MCP for browser automation (screenshots) |

## Prompt Structure

Every Claude spawn receives a prompt shaped like:

```
<identity>
# IDENTITY.md - Who Am I?
- Name: Junior
- Vibe: Witty but direct. Indiana Jones Jr. energy.
...

# SOUL.md — Junior
[full persona: core truths, communication style, failure signals, decision rules]

Your Slack user ID is U12345. Messages from this user ID in the thread are yours.
</identity>

<slack-context>
Channel: #eng-bots (C0123ABC)
Thread: 1773749331.950109
You are responding in this thread. You already have the full thread history below.
Do NOT use Slack search or read tools to find this thread.
</slack-context>

<thread-context>
User(U678): can you review the auth middleware?
Junior (you): Sure, I'll take a look.
User(U901): [shared image: screenshot.png] here's what I see
</thread-context>

The user shared images. They are saved at these paths — use the Read tool to view them:
- /tmp/junior-files/1773749331.950109/screenshot.png

[actual user message here]
```

## Design Decisions

### Persona from openclaw workspace, not hardcoded
SOUL.md has 130+ lines of calibrated behavioral rules refined over months. Loading it preserves the full personality without maintaining a duplicate.

### Thread context fetched server-side, not via MCP
The orchestrator already has the bot token and thread_ts. Fetching via `conversations.replies` is one API call. Giving Claude a Slack MCP tool would add latency (Claude has to search for the thread) and token waste (20+ MCP calls observed in testing).

### Channel name cached
`resolveChannelName()` caches channel ID → name to avoid repeated API calls for messages in the same channel.

### Identity matching by user_id only
Slack's `bot_id` field is on ALL bot messages, not just ours. Only `m.user === botUserId` correctly identifies Junior's messages. Other bots (Friday, Doraemon) show as regular users in thread context.

### Image files downloaded to /tmp
Images are downloaded with the bot token as auth, saved to `/tmp/junior-files/<threadId>/`. Claude can `Read` these files natively. Only image MIME types (png, jpeg, gif, webp) are downloaded.

### Env vars for outbound Slack access
Spawned Claude processes get `SLACK_CHANNEL`, `SLACK_THREAD_TS`, `SLACK_BOT_TOKEN` as env vars. This lets `bin/slack-upload.sh` work without any configuration — Claude just runs the script.

## Browser Automation

Playwright MCP (`.mcp.json`) gives Claude browser tools: navigate, click, scroll, type, screenshot. The workflow for sharing what it sees:

1. Claude takes screenshot via Playwright MCP → saves to file
2. Claude runs `bin/slack-upload.sh /tmp/screenshot.png "Here's what I found"`
3. Image appears in the Slack thread

## Message Deduplication

Slack fires both `message` and `app_mention` for @mentions in threads. Without dedup, the same message gets processed twice (first spawns Claude, second gets buffered and drained as a duplicate). Fixed with a `Set<string>` keyed on message `ts` in `SessionManager.handleMessage()`.
