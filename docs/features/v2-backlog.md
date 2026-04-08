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
