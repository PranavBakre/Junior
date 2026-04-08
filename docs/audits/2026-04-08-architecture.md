# Architecture Conventions Audit — 2026-04-08

Reviewed all 19 source files against `docs/architecture.md` (8 decisions) and `CLAUDE.md` (15 rules).

## Warnings (7)

| # | File:Line | Issue | Fix |
|---|---|---|---|
| 1 | `spawner.ts:13` | `process.cwd()` fallback when `worktreePath` is null sets cwd to junior itself. Review/architect threads with `targetRepo` set but no worktree get junior's CLAUDE.md instead of the target repo's. Violates decision 4 (cwd → target repo). | Fall back to target repo path before `process.cwd()`. Requires passing `targetRepo` path to spawner. |
| 2 | `slack/responder.ts` | No `SlackClient` interface. Concrete class used directly. Decision 6 says 4 boundaries need interfaces. | Extract interface, inject in index.ts. |
| 3 | `claude/spawner.ts` | No `ClaudeSpawner` interface. Function imported directly by session manager. | Extract interface or inject function. |
| 4 | `worktree/manager.ts` | No `WorktreeManager` interface. Concrete class. | Extract interface. |
| 5 | `manager.ts:9` | `spawnClaude` is a direct import, not injected like `agentRouter` and `worktreeManager`. Inconsistent — spawner is the only peer module that can't be swapped for testing. | Inject via property like the other two. |
| 6 | `manager.ts:285` | `runClaudeWithAgent(session, combined)` not awaited in async `onRunComplete`. Synchronous throw = unhandled rejection. | Add `.catch()`. |
| 7 | `cleanup.ts:12` | Doesn't skip `draining` sessions. Race during brief draining window could delete session and lose buffered messages. | Also skip `draining` status. |

## Nits (3)

| # | File:Line | Issue |
|---|---|---|
| 8 | `worktree/types.ts:1` | `WorktreeInfo` exported but never imported. Dead code. |
| 9 | `session/manager.ts` | No extracted `validateTransition()` pure function per decision 7. Inline conditionals work but can't be unit-tested in isolation. |
| 10 | `.claude/worktrees/` | Stale worktree directories from agent builds. Orphaned test file copies. |

## Compliant (no issues)

- **Decision 1** (control plane / data plane): Worktrees only in target repos.
- **Decision 2** (session manager as hub): ThreadSession is the integration contract. No module bypasses it.
- **Decision 3** (spawner as dumb executor): No agent/Slack/worktree knowledge in spawner.
- **Decision 5** (stream-json as boundary): Parser is sole consumer of stdout.
- **Decision 8** (no circular deps): Import graph is acyclic. Confirmed by tracing every import.
- **Rule 1** (CLI not SDK): `Bun.spawn(["claude", ...])`, no SDK imports.
- **Rule 4** (buffer don't interrupt): Buffering when busy, kill only on explicit reset or timeout.
- **Rule 5** (worktrees for target repos): Worktree paths always inside `repo.path`.
- **Rule 12** (zombie handling): withTimeout wraps every spawn, health check on 60s interval.

## Doc/Code Divergences (not bugs)

- CLAUDE.md lists `src/session/store/redis.ts` — doesn't exist yet (MVP).
- Architecture decision 8 describes EventEmitter — implementation uses callback properties (simpler, equivalent).
- No dedicated `stream-to-slack` module — handled by callback wiring in index.ts.
