# V2 Backlog

Features explicitly deferred from MVP. To be scoped when MVP is running.

## Admin Dashboard

**Problem:** No visibility into what's happening across threads. How many sessions are active? Which threads are stuck? What agent types are being used? Which repos? Without a dashboard, debugging requires reading server logs.

**Scope (to be refined):**
- Live session graph: threads as nodes, edges showing dependencies (drain chains, worktree sharing)
- Per-session detail: agent type, status (idle/busy/draining), last activity, pending message count, worktree path, session ID
- Activity timeline: message received → Claude spawned → events streamed → response posted, with timestamps
- Error log: failed spawns, timeouts, orphaned sessions — filterable
- Who's using what: Slack user → threads → agent types → repos
- Metrics: response latency p50/p99, timeout rate, buffer frequency, agent type distribution

**Open questions:**
- Web UI or Slack-native (home tab)? Web gives more flexibility. Slack home tab is zero-deploy.
- Real-time or polling? EventSource/WebSocket from the bot server, or periodic API calls?
- Auth? If web UI, who can see the dashboard? Pranav only, or whole team?

## Batch User Resolution in Thread Context

**Problem:** `fetchThreadHistory()` resolves user names inside a `Promise.all` over all thread messages. Each message fires `resolveUserName()` and `resolveSlackMentions()` concurrently. The user name cache prevents duplicate API calls for the same user, but on first encounter with a large thread with many unique participants, this can burst many `users.info` calls and risk hitting Slack's Tier 2 rate limit (~20 req/min).

**Fix:** Pre-collect all unique user IDs from the thread (message authors + mentioned users), resolve them in a single batch before building message objects, then read from cache.

**Priority:** Low — current thread sizes are small. Becomes relevant when threads regularly exceed ~20 unique participants.

## Per-agent mute

**Problem:** `session.muted` is a single boolean on the parent `ThreadSession`. There is no way to mute *just* the reproducer (e.g. when it's looping noisily) while keeping the lead agent responsive.

**Scope (to be refined):**
- Move `muted: boolean` from `ThreadSession` onto each `agentSessions[name]` entry. Lead lives on the parent — either keep `ThreadSession.muted` as the lead's flag, or carve out a synthetic `agentSessions["lead"]` for symmetry.
- `!mute <agent>` / `!unmute <agent>` toggle the per-agent flag. `!mute all` mutes every agent currently registered in `agentSessions`.
- Update the home tab counter (`src/slack/home.ts`) to count *any* muted agent rather than `session.muted`.
- SQLite migration: add a `muted` column to the `agent_sessions` table (or store on the existing JSON blob). Old `muted` column on the parent stays for the lead until the model is unified.
- Buffer/drain logic in `src/session/manager.ts:86,127,651` must consult the agent in question, not the parent.

**Open questions:**
- Does `!mute` (no arg) become an alias for `!mute all`, or a usage error like `!reset`? Leaning toward usage error to stay consistent with `!reset`.
- Should muting an agent kill an in-flight process for that agent, or only suppress *future* turns? Today muting mid-turn discards the buffer (`manager.ts:651`) but lets the running process complete — that behavior probably ports over.

## Thread-owner-based command access

**Problem:** Today admin gating is a single env var (`ADMIN_SLACK_USER_ID`). The original sketch was richer — env admin + a SQLite-backed list of additional admins, plus letting the *thread owner* (first non-bot author) run elevated commands in their own thread.

**Scope (to be refined):**
- Persist `ownerSlackUserId` on `ThreadSession`, set from the first user message that creates the session. Survives `!reset all`.
- `isAdmin(userId, session?)` returns true if `userId === envAdmin` OR `userId === session.ownerSlackUserId`.
- Optional: SQLite `admins` table (`slack_user_id PRIMARY KEY, granted_by, granted_at`) plus `!admin add @user` / `!admin remove @user` / `!admin list`. Env admin is the bootstrap and cannot be removed via the command (they're not in the table).
- Decide: do owners get *all* elevated commands, or only a safe subset (e.g. mute/unmute on their own thread but not reset)?

**Open questions:**
- Legacy threads have no `ownerSlackUserId`. Fall back to admin-only, or backfill from the first message?
- DMs — is the DM partner the "owner" by default? Probably yes.

## Image & Media Support from Slack

**Problem:** Users send screenshots, diagrams, error images, and file uploads in Slack threads. The bot currently ignores them — only `event.text` is passed to Claude. Claude Code can read images, so the capability is there but not wired.

**Scope (to be refined):**
- Detect file uploads in Slack messages (`event.files` array)
- Download files via Slack API (`files.info` + private URL with bot token)
- For images (png, jpg, gif, webp): pass as file path to Claude (Claude Code reads images natively)
- For documents (pdf, txt, csv): save to temp dir, pass path to Claude
- For code files: extract content, include inline in prompt
- Media cleanup: delete temp files after session completes or on stale cleanup
- Size limits: skip files > 10MB, warn user

**Open questions:**
- Does `claude -p` accept image files via stdin or only via file path in the working directory?
- Multiple files in one message — pass all or just the first?
- Should media be saved in the worktree (so Claude can reference them) or in a temp dir?
