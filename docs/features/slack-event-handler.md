# Slack Event Handler

## Problem

The bot needs to receive Slack messages and route them to the right session. A message in a thread should go to that thread's Claude Code session. A new thread should create a new session. The bot must handle app_mentions, direct messages, in-channel thread replies, and — for some channels — auto-triggered top-level messages with no mention required.

**Who has this problem:** The Slack bot server — it's the entry point for all user interaction.
**Painful part:** Slack's event API has quirks — duplicate events, thread_ts vs ts confusion, rate limits. On top of that, Junior shares a workspace with sibling Claude bots (Friday, Doraemon) whose "thinking" updates leak in as messages, and Junior must receive its own posts so orchestrator agents can hand off to workers via `!<agent>` directives — without falling into a self-reply loop.
**"Finally" moment:** A Slack message triggers a Claude Code response in the same thread, reliably, with no echo loops and no cross-bot noise.

## Full Vision

- Receive all relevant Slack events via Socket Mode (no public URL).
- Route messages to the correct thread session (`thread_ts` or `ts`).
- Handle `app_mention`, DMs, in-thread replies, and auto-trigger channels (e.g. `#bugs-backlog`) where no mention is needed.
- Receive the bot's own posts (`ignoreSelf=false`) so orchestrator agents can dispatch workers via `!<persistent-agent>`. Drop incidental self-bot chatter to avoid loops.
- Drop sibling-bot streaming updates (lines that start with `✽`).
- Strip the bot's own `<@U…>` mentions from anywhere in the text before parsing.
- Parse `!<command>` from the start of the message; pass `{ threadId, channel, user, text, ts, command, files }` to the session manager.
- Acknowledge events quickly (Slack expects <3s response).
- Publish a compact home tab summary of recent sessions, with permalinks and session metadata. Detailed per-session data opens in Slack modals from Home tab buttons.

## Dependencies

- Slack Bolt SDK (`@slack/bolt`), Socket Mode app with bot token + app-level token.
- Session Store (feature: [session-management.md](session-management.md), [session-persistence.md](session-persistence.md)) — used to check whether a thread has an active session.
- Command parser ([thread-commands.md](thread-commands.md)) — `parseCommand` lives in `src/slack/commands.ts`.
- Persistent agent registry ([persistent-agents.md](persistent-agents.md)) — `isPersistentAgent` used by the self-bot dispatch carve-out.

## Current Implementation

### Files

- `src/slack/app.ts` — `createSlackApp(config)` builds the Bolt `App` with Socket Mode and `ignoreSelf: false`.
- `src/slack/events.ts` — `registerEventHandlers(app, onMessage, store?, selfBotId?, selfUserId?, autoTriggerChannels?)`. Registers `message` and `app_mention` listeners.
- `src/slack/commands.ts` — `parseCommand(text)` extracts a leading `!<word>` from `KNOWN_COMMANDS`. `!<persistent-agent>` directives (e.g. `!lead`, `!reproducer`, `!thinker`, `!review`) are **not** in this set — they pass through with the prefix intact for the agent dispatcher.
- `src/slack/responder.ts` — `SlackResponder` wraps `chat.postMessage`, `chat.update`, `chat.delete`, and `reactions.add`. Handles response splitting (via `formatting.ts`), agent identity (`username` + `icon_emoji` on posts), and per-agent status pills keyed by `${threadTs}:${agentName}` with a 1s debounce.
- `src/slack/home.ts` — `registerHomeTab` listens for `app_home_opened` and `home_session_details` button actions. `publishHomeTab` calls `store.getRecent(windowMs)`, resolves Slack permalinks, and renders blocks: stats summary (active/idle/draining/errors/muted/total), Active Sessions, Recent Sessions (last 10 idle), Recent Errors (last 5). Each session block stays compact (status, lead agent, provider, repo, last activity, mute flag, pending count, agent count) and includes a `View details` button. Detail modals show worktree path, resume command, per-agent resume/status rows, and last error, split into Slack-safe section blocks. Last-error text is passed through the same prompt-leak sanitizer used for runner error replies before it appears in Home or modals.
- `src/slack/files.ts` — `downloadSlackFiles(files, threadId, botToken)` fetches Slack attachments to `/tmp/junior-files/<threadId>/` so the runner can read them from disk.

### Drop rules in `events.ts`

Every drop is logged via `logDrop(reason, evMeta)` for tracing. Order matters:

1. **`self-bot`** — `event.bot_id === selfBotId`, **and** the channel is not in `autoTriggerChannels`, **and** the text does not contain a `!<persistent-agent>` directive line. The carve-outs let auto-trigger channels and orchestrator hand-offs through; everything else is dropped to prevent reply loops.
2. **`no-text`** — event has no `text` field (e.g. file-only `message_changed`).
3. **`foreign-bot-thinking`** — text starts (after trim) with `✽`. These are streaming "thinking" updates from sibling Claude bots (Friday, Doraemon).
4. **`no-user`** — no resolvable user. Auto-trigger channels fall back to `selfUserId` for self-bot posts and to `bot_id` for other bots (e.g. service-account reporters with no `user` field).
5. **`top-level-no-mention`** — top-level channel message (not a thread, not a DM, not an auto-trigger channel). `app_mention` handles real mentions; this drops the rest.
6. **`no-session`** — in-thread reply on a non-auto-trigger channel where `store.get(thread_ts)` returns nothing. The bot only continues conversations it started.

### Auto-trigger channels

Channels listed in `autoTriggerChannels` (e.g. `#bugs-backlog`) bypass the mention requirement and the no-session check. Top-level messages from human users, service-account bots, and Junior itself are all routed. This is what lets the bug pipeline pick up new reports without `@Junior`.

### Mention stripping

`stripOwnMention(text, selfUserId)` replaces **every** `<@selfUserId>` token in the text (not just a leading one), then trims. Without `selfUserId`, it falls back to stripping a single leading `<@…>` token. This runs before `parseCommand`, so `<@JUNIOR> !build fix x` parses as command `build` with text `fix x`.

### Outgoing event shape

```ts
interface SlackMessageEvent {
  threadId: string;          // thread_ts if in a thread, else ts
  channel: string;
  user: string;              // user id, or bot_id fallback in auto-trigger channels
  text: string;              // mention-stripped, command-stripped
  ts: string;
  command: string | null;    // null if not in KNOWN_COMMANDS
  files?: { url; name; mimetype }[];
  isSelfBot?: boolean;       // true when bot_id matched selfBotId
  botUsername?: string;      // event.username, when present
}
```

### Responder note: `NO_SLACK_MESSAGE` sentinel

The handler doesn't see the sentinel — it's enforced downstream in `formatting.ts`. Agents that post via the slack-bot MCP and don't want a duplicate top-level reply return exactly `NO_SLACK_MESSAGE`; `splitResponse` returns no chunks and the responder skips posting. Messages ending with the sentinel have it stripped. See `src/slack/formatting.ts` and [thread-context.md](thread-context.md) for the agent-facing instructions.

## Iterations

### Iteration 0: Echo bot (shipped)

Bolt + Socket Mode wired up; reply in thread to a `message` event.

### Iteration 1: Event filtering and routing (shipped)

Drop rules, `threadId` extraction, structured event passed to session manager. Now extended with self-bot handling, foreign-bot drop, auto-trigger channels, and no-session guard (see above).

### Iteration 2: Command parsing (shipped)

`parseCommand` strips `!<word>` from message start when the word is in `KNOWN_COMMANDS`. See [thread-commands.md](thread-commands.md) for the command set and admin gating (`!reset`, `!mute`, `!unmute`, `!agent`).

### Iteration 3: DM, edits, files (partly shipped)

- DMs (`channel_type === "im"`) bypass the mention requirement.
- Message edits/deletes have no `text` and fall through `no-text`.
- File uploads: attachments are downloaded by `files.ts` and the local paths are passed to the runner as context.
- No outgoing rate-limit beyond the 1s status-pill debounce.

## Shortcuts

| Shortcut | Replaced in |
|---|---|
| Non-image file uploads ignored | Post-MVP — only metadata would be passed today |
| No outgoing rate limiter (only status-pill debounce) | Relies on Slack-side limits; revisit if 429s appear |

## Cut List (true v2)

- Slack interactive components (buttons, modals, dropdowns).
- Emoji reactions as commands (`:rocket:` → deploy).
- Multi-workspace support (multiple Slack workspaces).
- Message scheduling / delayed responses.
