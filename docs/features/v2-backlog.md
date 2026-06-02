# V2 Backlog

Features explicitly deferred from MVP. To be scoped when MVP is running.

## Admin Dashboard (DONE)

**Status:** Completed as the [HTTP Dashboard](./http-dashboard.md). Surfaces live sessions, dev-server queue, logs, and docs.

## Batch User Resolution in Thread Context

**Problem:** `fetchThreadHistory()` resolves user names inside a `Promise.all` over all thread messages. Each message fires `resolveUserName()` and `resolveSlackMentions()` concurrently. The user name cache prevents duplicate API calls for the same user, but on first encounter with a large thread with many unique participants, this can burst many `users.info` calls and risk hitting Slack's Tier 2 rate limit (~20 req/min).

**Fix:** Pre-collect all unique user IDs from the thread (message authors + mentioned users), resolve them in a single batch before building message objects, then read from cache.

**Priority:** Low — current thread sizes are small. Becomes relevant when threads regularly exceed ~20 unique participants.

## Hot Reload for Agent Org Assets

**Status:** Deferred from Dynamic Workflows v1.

**Problem:** Dynamic workflows use file-owned config plus `fs.watch` hot reload, so operators can add or fix workflows without restarting Junior. Agent org assets still depend mostly on boot-time loading.

**Scope (to be refined):**
- Apply the same watch-and-rescan model to supported agent org assets.
- Keep roots fixed and explicit; avoid env-driven discovery until the operational model needs it.
- Preserve last-known-good data when an edited private overlay becomes invalid.
- Keep manual reload commands as diagnostic repair tools, not the normal deployment path.
- Define which assets can be reloaded safely in-process and which require draining active sessions first.

**Open questions:**
- Should active sessions pin the identity/prompt version they started with, or adopt new identity data on the next turn?
- Should invalid org overlays fail closed for private assets, or fall back to public defaults?
- Which command surface owns this: a general `!org reload`, per-asset commands, or an admin dashboard action?

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

**Status:** Two-tier admin (env + SQLite `admins` table) shipped — see [thread-commands.md](thread-commands.md#admin-only-commands). Thread-owner branch is still open.

**Problem:** Today admin gating is env + SQLite. The original sketch also let the *thread owner* (first non-bot author) run elevated commands in their own thread.

**Scope (to be refined):**
- Persist `ownerSlackUserId` on `ThreadSession`, set from the first user message that creates the session. Survives `!reset all`.
- `isAdmin(userId, session?)` returns true if env-match OR DB-match OR `userId === session.ownerSlackUserId`.
- Slack-command admin management (`!admin add @user` / `!admin remove @user` / `!admin list`) was deliberately scoped out — admins added by direct SQL is the v1 UX. Revisit only if admin churn becomes frequent enough that SQL access is a bottleneck.
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
