# Process Lifecycle & Reliability

## Problem

Claude Code CLI processes can hang, crash, or produce errors. The bot needs to handle every failure mode gracefully — timeouts, spawn failures, non-zero exits, malformed output — without crashing itself or leaving sessions in a broken state. A zombie Claude process that never exits blocks the thread forever.

**Who has this problem:** The bot server — one bad process shouldn't take down the whole system.
**What happens today:** Nothing — no error handling.
**Painful part:** The failure modes are many and subtle. Process hangs (no output, no exit). Process exits with non-zero but no stderr. Process produces partial JSON (stdout cut mid-line). Process exits mid-stream (session state may be corrupt). Max subscription rate limit hit (unclear error). The bot must handle all of these without human intervention.
**"Finally" moment:** Claude hangs → user sees "Timed out after 5 minutes. Try a more specific prompt." Claude crashes → user sees "Something went wrong. Try again." No zombie processes. No stuck sessions.

## Full Vision

- Timeout guard on every spawned process (configurable, default 5 min)
- Graceful shutdown: SIGINT first, SIGKILL after grace period
- Error categorization: timeout, crash, rate limit, auth failure, unknown
- User-facing error messages in Slack (not raw stderr)
- Session state recovery: if process dies mid-turn, session stays resumable
- Health check: periodic scan for orphaned processes
- Metrics: track success/failure/timeout rates per agent type
- Graceful bot shutdown: on SIGINT/SIGTERM, wait for running processes to finish

## Dependencies

- Claude Spawner (feature: [claude-spawner.md](claude-spawner.md)) — wraps process lifecycle
- Session Manager (feature: [session-management.md](session-management.md)) — updates session state on failure

## Iterations

### Iteration 0: Basic timeout (~15 min)

Prevent processes from running forever.

**What it adds:**
- `setTimeout` on every spawned process (5 min default)
- On timeout: `proc.kill('SIGINT')`, wait 10s, `proc.kill('SIGKILL')` if still alive
- Clear timeout on normal exit
- Session set to idle on timeout

**Test:** Mock a hanging process (or spawn Claude with a prompt that takes forever). Process killed after 5 min. Session goes idle. No zombie.
**Defers:** Error categorization, user messages, graceful bot shutdown.

### Iteration 1: Error handling and user messages (~30 min)

Categorize errors and give users actionable feedback.

**What it adds:**
- On non-zero exit: read stderr, categorize:
  - Exit code 1 + "rate limit" in stderr → "Rate limited. Try again in a minute."
  - Exit code 1 + "auth" in stderr → "Authentication issue. Check Max subscription."
  - Exit code 1 + other → "Claude encountered an error. Try again."
  - Exit code 137 (SIGKILL) → "Process killed (likely out of memory)."
  - Timeout → "Timed out after 5 minutes. Try a more specific prompt."
- On spawn error (ENOENT — claude binary not found) → "Claude Code CLI not found. Is it installed?"
- Post error message to Slack thread
- Set session to idle (not stuck in busy)

**Test:** Kill a Claude process mid-run → user sees error message, session goes idle. Remove `claude` binary → spawn error caught, user informed.
**Defers:** Retry logic, metrics, health check.

### Iteration 2: Session state recovery (~30 min)

Ensure sessions are resumable after failures.

**What it adds:**
- If process dies before `init` event (no session ID extracted) → session stays at `sessionId: null`, next message creates fresh session
- If process dies after `init` event → session ID is valid, next message can `--resume`
- If process dies during buffer drain → re-drain with the same combined prompt
- Add `lastError` field to session: `{ type, message, timestamp }` for debugging
- Clear `lastError` on next successful turn

**Test:** Kill process after init event → next message in thread successfully resumes. Kill process before init → next message starts fresh. Kill during drain → drain retries.
**Defers:** Corruption detection (is the session file valid?).

### Iteration 3: Graceful bot shutdown (~20 min)

When the bot itself shuts down (SIGINT, SIGTERM, restart), handle running processes.

**What it adds:**
- On bot SIGINT/SIGTERM: set `shuttingDown = true`
- Reject new messages with "Bot is restarting. Try again in a moment."
- Wait for all running Claude processes to finish (with their own timeouts)
- If processes don't finish in 30s, SIGINT them
- Then exit cleanly
- Log all active sessions at shutdown (for debugging)

**Test:** Start bot, trigger Claude. While Claude runs, send SIGINT to bot. Bot waits for Claude to finish, then exits. If Claude takes too long, it gets killed first.
**Defers:** Zero-downtime restarts, session handoff between bot instances.

### Iteration 4: Health check and orphan cleanup (~20 min)

**What it adds:**
- Background interval (every 5 min): check all sessions with status `busy`
- For each busy session: verify the child process PID is still alive (`kill(pid, 0)`)
- If PID is dead but session is still busy → orphaned. Reset to idle, post error to Slack.
- Track PIDs in session: `session.pid = proc.pid`
- On bot startup: scan for any orphaned worktrees from previous runs

**Test:** Manually kill a Claude process (not via bot). Health check detects orphan, resets session, posts error. Session becomes usable again.
**Defers:** Metrics dashboard, alerting.

## Shortcuts

| Shortcut | Replaced in |
|---|---|
| Console.log for errors | Iteration 1 (user-facing messages) |
| No graceful shutdown | Iteration 3 |
| No orphan detection | Iteration 4 |
| No retry on failure | By design — user re-sends |

## Cut List (true v2)

- Automatic retry with exponential backoff
- Circuit breaker (if N failures in M minutes, stop spawning)
- Metrics/observability (success rate, latency p50/p99, timeout rate)
- Alerting (Slack DM to Pranav on repeated failures)
- Multi-process per thread (parallel tool execution)
- Session file corruption detection and repair
