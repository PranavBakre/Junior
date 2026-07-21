# Thread Clear Command (`!clear`)

> **Current status (2026-07-21):** Shipped. The implementation lives in `src/slack/thread-archive.ts` and the command is handled by the thread-command path. The sections below preserve the original behavior specification and test plan.

Date: 2026-05-28

The `!clear` command archives a Slack thread to markdown on disk, then deletes every message posted by Junior (including agent personas) from that thread.

## Problem

Long Junior threads accumulate dozens of status pills, multi-chunk responses, and agent handoffs. The conversation is useful history, but the Slack UI becomes noisy. Users want to tidy the thread without losing context and without resetting the coding session (`!reset` is the wrong tool — it kills runners and wipes session state).

**Who has this problem:** Anyone running multi-turn bug-pipeline or build threads where Junior, Lead, Reproducer, Thinker, and Reviewer have posted many messages.

**What happens today:** Admins can use `!clear` to preserve a local archive, delete Junior-authored messages, and leave session/provider state untouched.

**Painful part:** Deletion without backup is irreversible. Slack's own message retention policies vary by workspace; Junior should not assume Slack search or exports will preserve the thread.

**"Finally" moment:** `!clear` in a cluttered thread → Junior posts one confirmation with the archive path → the thread shows only human messages plus that confirmation. Session state, worktree, and `--resume` / `--session` continuity are untouched.

## Recommendation

Add **`!clear`** as an **admin-gated**, **non-destructive-to-session** housekeeping command:

1. Fetch the full thread (paginated).
2. Write a markdown archive file locally.
3. Delete every message whose author is this Junior bot installation (`selfBotId` / `botUserId`).
4. Post a short confirmation with archive path and delete count.
5. Clear in-memory status-pill tracking for that thread.

Do **not** reset session state, kill runners, or remove worktrees. That remains `!reset` / `!cancel` territory.

## Behavior Spec

### Invocation

```
!clear
```

No arguments in v1. Unknown trailing text is ignored (consistent with `!quiet` / `!status`).

### Permissions

**Admin-gated**, same model as `!reset`, `!mute`, `!unmute`, and `!driver`:

- Env bootstrap: `ADMIN_SLACK_USER_ID`
- SQLite extras: `admins` table in `data/sessions.db`
- Open mode when both tiers are empty (local dev)
- Non-admin: silent `❌` reaction on the trigger message, no thread reply (same as `denyIfNotAdmin`)

Rationale: bulk deletion is irreversible in Slack even with a local archive; treat it like other destructive admin operations.

### What gets archived

**All messages in the thread** — humans, Junior, foreign bots, file-share annotations — in chronological order. This preserves full conversational context even though only Junior messages are deleted.

Reuse the same enrichment as `buildPromptPreamble` / `fetchThreadHistory`:

- Resolve `@mentions` to display names via `resolveSlackMentions`
- Resolve user IDs via `resolveUserName`
- Annotate shared files as `[shared file: name]`
- Label roles clearly (see Archive format below)

Include metadata header: channel name/id, thread ts, archive timestamp, triggering user, message counts.

### What gets deleted

Messages authored by **this Junior installation**:

| Signal | Rule |
|---|---|
| Primary | `message.bot_id === selfBotId` |
| Fallback | `message.user === botUserId` when `bot_id` absent |

This covers:

- Default Junior posts
- Agent persona posts (`username` / `icon_emoji` overrides — still same bot token)
- Status pills posted or updated by `SlackResponder`
- Multi-chunk responses (each chunk is its own message ts)
- MCP `slack_send_message` posts from spawned runners

**Not deleted:**

- Human messages (including the `!clear` trigger)
- Foreign bots (Friday, CI webhooks, etc.)
- The confirmation message Junior posts after `!clear` completes

### Busy-thread policy

**Block while any runner handle is active** for this thread (same guard pattern as `!provider`):

```
Cannot clear while a runner is active. Use `!cancel` or wait for the turn to finish.
```

Reason: a mid-turn runner may still be posting chunks/status updates; deleting concurrently produces races and partial clears. Users can `!cancel` first if they need an immediate clear.

Alternative considered and rejected for v1: auto-cancel then clear. Too surprising — `!clear` should not kill in-flight work.

### Confirmation reply

Single Slack message (not deleted):

```
Cleared *N* Junior message(s) from this thread.
Archive: `data/thread-archives/<file>.md`
```

If `N === 0`:

```
No Junior messages to clear. Archive saved to `data/thread-archives/<file>.md` anyway.
```

(Still write the archive — cheap insurance, and users may want a snapshot before a future clear.)

### Session impact

| State | Effect |
|---|---|
| `sessionId` / agent session IDs | Unchanged |
| Worktree | Unchanged |
| `pendingMessages` | Unchanged |
| `dormant` / `muted` / verbosity | Unchanged |
| `SlackResponder.statusMessages` | Clear all keys matching `${threadTs}:*` |
| `SlackResponder.pendingStatusPosts` | Best-effort cancel/await for same keys |

Thread history injected into future runner prompts will shrink naturally (Slack no longer returns deleted messages in `conversations.replies`). Operators should know that **runner resume context may lose Slack-side history** after a clear; native provider session IDs still carry model-side context.

## Archive Format

**Directory:** `data/thread-archives/` (new; configurable via env — see Config)

**Filename:** `{channelSlug-or-id}_{threadTs}_{iso-date}_{short-id}.md`

Example: `tech-support_1716890123.456789_2026-05-28_a1b2c3.md`

**Body:**

```markdown
# Thread archive

| Field | Value |
|---|---|
| Channel | #tech-support (C01234567) |
| Thread | 1716890123.456789 |
| Archived at | 2026-05-28T14:32:01.234Z |
| Triggered by | Pranav (<@U01234567>) |
| Messages total | 47 |
| Junior messages deleted | 31 |

---

## Messages

**User(Pranav <@U01234567>)** · 2026-05-28 14:01:02 UTC · `1716890123.456789`
> @Junior the login button is broken on staging

**Junior (Lead)** · 2026-05-28 14:01:15 UTC · `1716890124.123456`
> On it — spawning reproducer.

**Reproducer** · 2026-05-28 14:02:40 UTC · `1716890160.789012`
> Reproduced on staging. Steps: …

**User(Alice <@U07654321>)** · 2026-05-28 14:05:00 UTC · `1716890300.111111`
> !aside stepping out for lunch

…
```

Formatting notes:

- Use blockquotes for message bodies; escape or fence if bodies contain markdown-breaking content.
- Include `ts` on every row so a future `!restore` (v2) could theoretically re-post — out of scope for v1.
- For deleted messages, optional HTML comment `<!-- deleted by !clear -->` is unnecessary in v1 since the archive is written before deletion.

## Implementation Plan

### New module: `src/slack/thread-archive.ts`

Pure-ish helpers (testable without Bolt):

| Function | Purpose |
|---|---|
| `fetchFullThreadReplies(client, channel, threadTs)` | Paginate `conversations.replies` until exhausted |
| `formatThreadArchiveMarkdown(meta, messages)` | Build archive string |
| `isJuniorMessage(msg, selfBotId, botUserId)` | Deletion filter |
| `writeThreadArchive(baseDir, filename, content)` | `mkdir -p` + atomic write |

Pagination: loop with `cursor` while `response_metadata.next_cursor` is set. Slack returns up to ~200 messages per call for `conversations.replies`; typical bug threads fit in 1–2 pages.

Deletion: sequential `chat.delete({ channel, ts })` with best-effort error handling (log and continue). Already used in `SlackResponder.deleteStatus`. Rate-limit: small delay or batch if threads exceed ~50 bot messages (unlikely v1 concern).

### Touch existing files

| File | Change |
|---|---|
| `src/slack/commands.ts` | Add `"clear"` to `KNOWN_COMMANDS` |
| `src/session/manager.ts` | `case "clear":` in `handleCommand`; wire archive + delete; inject `selfBotId` on manager (see below) |
| `src/slack/responder.ts` | Add `clearStatusForThread(threadTs)` to drop all status keys for a thread |
| `src/index.ts` | Pass `selfBotId` to `SessionManager` (alongside existing `botUserId`) |
| `src/session/manager.test.ts` | Unit tests with mocked Slack client |
| `src/slack/commands.test.ts` | Parse test for `!clear` |
| `docs/features/thread-commands.md` | Add to Full Vision + admin list |
| `docs/code_index/thread-commands.md` | Command table row |
| `README.md` | One-line in command list |

### SessionManager dependencies

Today `SessionManager` has `botUserId` and `slackApp`. It needs **`selfBotId`** for reliable bot-message detection (matches `events.ts` and the MCP server's `Bot(${bot_id})` labeling).

```typescript
// index.ts (after auth.test)
sessionManager.botUserId = auth.user_id;
sessionManager.selfBotId = auth.bot_id;
```

The `clear` handler uses `this.slackApp.client` for API calls (same pattern as other manager code that touches Slack indirectly via callbacks — or accept `slackClient` if preferred for testability).

### Config

```typescript
// config.ts
threadArchives: {
  dir: optional("THREAD_ARCHIVE_DIR", "data/thread-archives"),
}
```

Add to `.gitignore` if not already ignoring `data/` (session DB and memory DB already live there).

### Slack scopes

No new scopes required. `chat:write` covers deleting messages posted by the bot. `channels:history` / `groups:history` already required for `conversations.replies`.

Verify in staging: bot cannot delete human messages (Slack returns `cant_delete_message`) — filter must be strict.

## Command Flow

```
User: !clear
  │
  ├── parseCommand() → { command: "clear", text: "" }
  │
  └── SessionManager.handleCommand
        ├── denyIfNotAdmin → ❌ if denied
        ├── busy guard → reply if any handle active
        ├── fetchFullThreadReplies(channel, threadId)
        ├── writeThreadArchive(data/thread-archives/…)
        ├── filter isJuniorMessage → chat.delete each
        ├── responder.clearStatusForThread(threadId)
        └── onCommandResponse(confirmation with path + count)
```

`handleCommand` returns `true` (consumed; no runner spawn).

## Edge Cases

| Case | Handling |
|---|---|
| Thread with only the parent message | Archive parent; `N = 0` if parent is human |
| `!clear` in a thread Junior was never in | Still archives; `N = 0` |
| Partial delete failure (Slack API error) | Continue deleting others; confirmation reports `N` succeeded; log failures |
| Status pill in-flight during clear | Blocked by busy guard; if idle, `clearStatusForThread` cleans map |
| Private channel / DM | Same code path; channel name resolution may fall back to ID |
| Message edited after archive | Archive captures pre-delete snapshot; acceptable |
| Foreign bot messages in thread | Archived, not deleted |
| Very large thread (500+ messages) | Pagination handles fetch; deletion may take several seconds — consider `:hourglass:` reaction at start, remove on completion |

## Testing

**Unit (`thread-archive.test.ts`):**

- `isJuniorMessage` true/false matrix (`bot_id`, `user`, foreign bot)
- Markdown formatter output stable for fixture messages
- Pagination merges cursors correctly (mock client)

**Integration (`manager.test.ts`):**

- Admin `!clear` → archive write called, delete called for bot messages only, confirmation posted
- Non-admin → `❌`, no archive, no deletes
- Busy thread → blocked message, no deletes
- `N = 0` path still writes archive

**Manual:**

1. Start thread, get Junior + Lead + Reproducer to post several messages.
2. `!clear` as admin → confirm human messages remain, bot messages gone, file exists on disk.
3. Send another message → runner still resumes via session ID.
4. Non-admin `!clear` → silent reject.

## Open Questions

1. **Include human messages in archive only, or offer `!clear --junior-only` archive?** Recommendation: always archive full thread in v1; simpler and more useful for audit.

2. **Upload archive to Slack as a file attachment?** Nice for operators without shell access to the Junior host. Defer to v2 (`files.upload` + link in confirmation).

3. **Retention / rotation** for `data/thread-archives/`? No automatic cleanup in v1; document disk growth. v2: cron or max-age env.

4. **Should `!clear` also delete the auto-dormant notice?** Yes, if it was posted by Junior (`bot_id` match).

5. **Thread-owner elevation** (v2 backlog): allow non-admins who own the thread to clear their own threads? Not in v1.

## Cut List (v2+)

- `!clear --dry-run` — show counts without deleting
- Upload archive to thread as `.md` file
- `!restore` from archive (re-post bot messages — likely low value)
- Auto-clear on `!reset all` (opt-in flag)
- HTTP dashboard link to browse archives

## Summary

| Item | Decision |
|---|---|
| Command | `!clear` |
| Admin only | Yes |
| Archives | Full thread → `data/thread-archives/*.md` |
| Deletes | Junior installation messages only |
| Session / worktree | Untouched |
| Busy threads | Block with message |
| New Slack scopes | None |
| Primary new code | `src/slack/thread-archive.ts` + `handleCommand` case |

Original estimate: **~2–3 hours** (implementation + tests + docs index updates).
