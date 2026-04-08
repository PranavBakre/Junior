# Slack Event Handler

## Problem

The bot needs to receive Slack messages and route them to the right session. A message in a thread should go to that thread's Claude Code session. A new thread should create a new session. The bot must handle app_mentions, direct messages, and in-channel thread replies.

**Who has this problem:** The Slack bot server — it's the entry point for all user interaction.
**What happens today:** Nothing — this is the first feature to build.
**Painful part:** Slack's event API has quirks — duplicate events, challenge verification, thread_ts vs ts confusion, rate limits on posting.
**"Finally" moment:** A Slack message triggers a Claude Code response in the same thread, reliably.

## Full Vision

- Receive all relevant Slack events via Socket Mode (no public URL needed)
- Route messages to the correct thread session
- Handle app_mentions (`@Junior`) and direct thread replies
- Ignore bot's own messages (no echo loops)
- Ignore messages in threads the bot isn't part of (unless mentioned)
- Extract thread context: who sent it, what channel, parent message
- Pass structured prompt to session manager: `{ threadId, channel, user, text, ts }`
- Support slash commands in messages (e.g., `/build`, `/review`, `/reset`)
- Acknowledge events quickly (Slack expects <3s response)

## Dependencies

- Slack Bolt SDK (`@slack/bolt`)
- Slack App with Socket Mode enabled, bot token, app-level token
- Session Manager (feature: [session-management.md](session-management.md))

## Iterations

### Iteration 0: Echo bot (~20 min)

Prove Slack connectivity works. Bot receives a message, replies in the same thread with the raw text.

**What it adds:** Slack Bolt app with Socket Mode, single event listener for `message`, reply in thread.
**Test:** Send a message in a Slack channel mentioning the bot. Bot replies in-thread with the message text.
**Defers:** Session management, Claude Code spawning, slash commands, filtering.

### Iteration 1: Event filtering and routing (~1h)

Add the filtering logic so the bot only processes relevant messages.

**What it adds:**
- Filter out bot's own messages (check `message.bot_id`)
- Filter out messages in channels where bot isn't mentioned (unless thread is already active)
- Extract `threadId` (use `thread_ts` if in a thread, otherwise `ts` as new thread root)
- Extract user info, channel, text
- Structured event object: `{ threadId, channel, user, text, ts }`
- Pass to session manager (stub — just logs the event)

**Test:** Bot ignores its own messages. Bot responds to mentions. Bot correctly identifies thread vs new message. Structured event logged to console.
**Defers:** Actual Claude Code spawning, slash command parsing, DM handling.

### Iteration 2: Slash command parsing (~30 min)

Parse inline commands from message text before passing to session manager.

**What it adds:**
- Parse `/build`, `/review`, `/frontend`, `/reset`, `/branch <ref>`, `/status` from message start
- Strip command from text, pass both command and cleaned text to session manager
- `/reset` handled directly — clears session (no Claude spawn needed)
- `/status` handled directly — replies with session state

**Test:** `/build fix the auth bug` → session manager receives `{ command: "build", text: "fix the auth bug" }`. `/reset` clears session and replies "Session reset." `/status` on idle thread replies "No active session."
**Defers:** Command-based agent routing (that's session manager's job).

### Iteration 3: DM support and edge cases (~30 min)

**What it adds:**
- Handle DMs to the bot (no mention required, thread_ts = conversation)
- Handle message edits (ignore — don't re-process)
- Handle message deletions (ignore)
- Handle file uploads (extract file info, pass as context)
- Rate limit outgoing messages (Slack limits ~1 msg/sec per channel)

**Test:** DM the bot → responds. Edit a message → no duplicate response. Upload a file with text → file info included in event.
**Defers:** File content extraction (just metadata for now).

## Shortcuts

| Shortcut | Replaced in |
|---|---|
| Console.log for errors | Iteration 3 or reliability feature |
| No rate limiting on outgoing | Iteration 3 |
| No file content extraction | Post-MVP |

## Cut List (true v2)

- Slack interactive components (buttons, modals, dropdowns)
- Message scheduling / delayed responses
- Emoji reactions as commands (e.g., react with :rocket: to deploy)
- Multi-workspace support (multiple Slack workspaces)
