# Post-Build Audit — 2026-04-08

Audited all 19 TypeScript source files after multi-agent build of 10 features. Traced every call path from index.ts through manager.ts to spawner.ts and back.

## Findings

### BLOCKER — 5 found, 5 fixed

| # | File:Line | Issue | Fix |
|---|---|---|---|
| 1 | `index.ts:39-41` | `onCommandResponse` logged to console, not Slack. `!status` and `!help` produced no visible response. | Changed to `responder.postResponse(event.channel, event.threadId, response)` |
| 2 | `index.ts` (missing) | `WorktreeManager` never instantiated. `session.worktreePath` always null — Claude always ran in `process.cwd()`. | Added `worktreeManager` property to SessionManager, create worktree in `runClaudeWithAgent` for build/frontend agents. |
| 3 | `lifecycle/timeout.ts` | `withTimeout` existed but was never called. Claude processes could hang forever. | Wrapped `spawnClaude` in `withTimeout(handle, config.claude.timeoutMs)` inside `runClaudeWithAgent`. |
| 4 | `lifecycle/health.ts`, `cleanup.ts` | `checkOrphanedSessions` and `cleanupStaleSessions` existed but no interval called them. | Added `setInterval` in index.ts — orphan check every 60s, stale cleanup on configured interval. |
| 5 | `events.ts:49` | `app_mention` event text includes `<@BOTID>` prefix. `parseCommand` couldn't find `!` at position 0. | Strip bot mention: `event.text.replace(/<@[A-Z0-9]+>\s*/g, "").trim()` |

### WARNING — 4 found, 4 fixed

| # | File:Line | Issue | Fix |
|---|---|---|---|
| 6 | `index.ts:20-22` | Status message ("Running: `git diff`...") never deleted after Claude finished. | Added `responder.deleteStatus()` in `onResponse` and `onError` callbacks. |
| 7 | `manager.ts:235` | `onResponse` fired even on error/empty response. Empty Slack message posted alongside error. | Guard: `if (result.response) { this.onResponse?.(session, result.response); }` |
| 8 | `manager.ts:56, 244` | `runClaudeWithAgent` called without error handling. Agent prompt composition or worktree creation could throw uncaught. | Wrapped entire method in try/catch. On failure: set session idle, record lastError, fire onError. |
| 9 | `worktree/manager.ts:73` | `Bun.file(path).exists()` checks files, not directories. Worktree paths are directories — always returned false. | Replaced with `node:fs/promises` `stat()` + `isDirectory()`. |

### NIT — 2 found, 2 fixed

| # | File:Line | Issue | Fix |
|---|---|---|---|
| 10 | `agents/router.ts:43-56` | Common preamble loaded from both target repo and fallback — duplicate content if both have `building-philosophy.md`. | Only load fallback if target repo had no common files. |
| 11 | `slack/formatting.ts:40` | `splitResponse("")` returned `[""]` — would post empty Slack message. | Added `if (!text) return [];` guard. |

## Commit

All fixes in commit `1835a05`:
```
fix 11 audit findings across all modules
```

## Method

Read all 19 source files. For each:
1. Checked imports reference real exports
2. Traced call paths (who calls this, who does this call)
3. Checked callback signatures match between caller and provider
4. Verified features are wired in index.ts
5. Looked for dead code and logic gaps

Key insight: all 5 blockers survived `bun run typecheck`. They were wiring gaps (module exists but nobody connects it), not type errors. Multi-agent builds that typecheck in isolation need a manual audit of integration points.
