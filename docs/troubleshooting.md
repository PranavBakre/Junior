# Troubleshooting Guide

## 1. Runner Not Found
**Symptoms:** "Command not found: opencode" or "claude" in logs.
- **Fix:** Ensure the required CLIs are installed and available in your `$PATH`.
- **Note:** Junior spawns these as subprocesses; if you can't run them in your terminal, Junior can't either.

## 2. TMUX Version Too Old
**Symptoms:** Interactive mode fails to paste prompts or errors on `-p`.
- **Requirement:** `tmux` version 3.4 or higher is required for the bracketed paste (`-p`) flag.
- **Check:** `tmux -V`
- **Fix:** Upgrade tmux via `brew upgrade tmux` (macOS) or your Linux package manager.

## 3. Slack Rate Limits
**Symptoms:** "ratelimited" errors in logs; messages delayed or skipped.
- **Cause:** Large threads with many participants or rapid-fire commands can hit Slack's Tier 2 limits.
- **Fix:** The bot will automatically retry with exponential backoff, but you can reduce noise by muting inactive threads (`!mute`).

## 4. SQLite Database Locked
**Symptoms:** "database is locked" errors during session persistence.
- **Cause:** Concurrent writers or a hung process holding a lock.
- **Fix:** Check for orphan `bun` processes. `bun run cleanup` can help clear stale state.

## 5. Dev Server Fails to Start
**Symptoms:** `!devserver` status shows `error` or times out.
- **Check:** Ensure the `devCommand` and `devPort` in your `REPOS` config are correct.
- **Logs:** Check `logs/<date>.log` for the specific stdout/stderr from the dev-server spawn.
