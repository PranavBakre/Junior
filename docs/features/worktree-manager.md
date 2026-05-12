# Worktree Manager

> **Two flows live here.** The single-target-repo flow (driven by `!repo <name>`) creates one worktree per thread at `session.worktreePath`. The bug-pipeline flow (lead-driven) creates one worktree per routed repo per thread at `session.worktreePaths[repo]`, plus a dedicated dev-server worktree per repo at a fixed path. See [bug-pipeline-worktrees.md](bug-pipeline-worktrees.md) for the full bug-pipeline design and [process-lifecycle.md](process-lifecycle.md) for the dev-server lifecycle that owns the dev-server worktree.

## Problem

When a Slack thread needs to edit code in a target repo (example-backend, example-frontend), it needs its own git worktree so concurrent threads don't collide on file state. The worktree manager creates, tracks, and cleans up worktrees in target repos — not in junior's own workspace.

**Who has this problem:** Any thread that does code work on a shared repo.
**What happens today:** Nothing — no code isolation.
**Painful part:** Worktree lifecycle. Creating is easy. Knowing when to create (not every thread needs one), cleaning up safely (check for uncommitted changes), and handling edge cases (stale branches, dangling worktrees from crashed processes) is hard.
**"Finally" moment:** Two Slack threads edit example-backend simultaneously. Neither sees the other's changes. Both can commit and push independently.

## Full Vision

- Create worktrees in target repos on demand
- Branch naming: `slack/<threadId>` from configurable base ref (default `origin/main`)
- Track worktree path per session
- Deferred creation: only create when thread actually needs to edit code
- Check worktree exists before resuming (may have been cleaned up)
- Clean up stale worktrees: remove after 24h inactivity if clean, warn if dirty
- Support multiple target repos (thread specifies which repo)
- Support custom base ref per thread (`!branch staging`)

## Dependencies

- Session Manager (feature: [session-management.md](session-management.md)) — stores worktree path
- Git installed on the host
- Target repos cloned locally with fetch access

## Configuration

```typescript
interface RepoConfig {
  name: string;                       // "app-backend"
  path: string;                       // "/Users/.../projects/app-backend"
  defaultBase: string;                // "origin/main"
  // Optional — bug-pipeline / dev-server fields:
  worktreeSetupCommand?: string;      // e.g. "bin/setup-worktree.sh" — resolved relative to `path`
  devCommand?: string;                // e.g. "pnpm dev", "npm run dev" — split on whitespace, no shell
  devPort?: number;                   // e.g. 3000, 8000 — readiness probe target
  readyUrl?: string;                  // e.g. "http://localhost:3000" — defaults to localhost:<devPort>
}
```

The bug-pipeline + dev-server fields are optional. Repos that only need the `!repo` flow can leave them unset; repos that participate in the bug pipeline set them per [bug-pipeline-worktrees.md](bug-pipeline-worktrees.md).

## Public API (current)

`WorktreeManager` (`src/worktree/manager.ts`):

- `createWorktree(repoName, threadId, baseRef?, branchOverride?) → Promise<worktreePath>` — creates a worktree at `<repo.path>.junior-worktrees/slack-<threadId>` (or whatever path `getWorktreePath` derives — note this is a sibling directory to the repo, deliberately outside `.claude/`). The new branch is `branchOverride ?? slack/<threadId>`; the starting ref is `baseRef ?? repo.defaultBase`. If `repo.worktreeSetupCommand` is set, the manager runs `<repo.path>/<command> <worktreePath> <branch>` instead of `git fetch + git worktree add`.
- `removeWorktree(repoName, threadId) → Promise<void>` — reads the actual current branch via `git -C <wt> branch --show-current` before deletion (so cleanup works for `branchOverride` callers), force-removes the worktree, and `git branch -D`s the branch. Both lookup and delete are wrapped in try/catch so missing/detached state is non-fatal.
- `worktreeExists(repoName, threadId) → Promise<boolean>` and `isWorktreeDirty(worktreePath) → Promise<boolean>` — used by cleanup.
- `getWorktreePath(repoName, threadId) → string` and `getBranchName(threadId) → string` — pure helpers (no I/O).

The MCP tool `mcp__slack-bot__register_worktree({ thread_id, repo, branch? })` (in `src/mcp/slack-server.ts`) wraps `createWorktree` for lead's intake and persists the resulting path into `session.worktreePaths[repo]` via the session store using the refetch-then-mutate pattern.

## Iterations

### Iteration 0: Create and remove (~20 min)

Bare functions to create and remove a worktree in a target repo.

**What it adds:**
- `createWorktree(repoPath, threadId, baseRef)` → returns worktree path
- `removeWorktree(repoPath, threadId)` → removes worktree and branch
- Both run `git worktree add/remove` via `execSync`
- Fetch before creating (`git fetch origin`) to ensure base ref is fresh

**Test:** Call `createWorktree`. Verify directory exists, branch exists, files are checked out. Call `removeWorktree`. Verify directory and branch removed.
**Defers:** Session integration, deferred creation, cleanup cron, dirty detection.

### Iteration 1: Session integration (~30 min)

Wire worktree creation into the session manager flow.

**What it adds:**
- Session manager calls `createWorktree` when thread needs code isolation
- Worktree path stored in `session.worktreePath`
- Claude spawner uses `session.worktreePath` as `cwd`
- Worktree existence check before `--resume` (recreate if missing)
- Default repo configurable, overridable with `!repo example-frontend`

**Test:** `!build fix auth` → worktree created in example-backend, Claude runs in that worktree. Second message in same thread → same worktree reused. `!repo example-frontend` then `!build` → worktree in example-frontend instead.
**Defers:** Deferred creation, cleanup, custom base ref.

### Iteration 2: Deferred creation (~30 min)

Don't create worktrees eagerly. Only create when Claude actually needs to write files.

**What it adds:**
- Threads start without a worktree (Claude runs in target repo root, read-only effectively)
- If Claude's first tool call is `Edit`, `Write`, or `Bash` (that modifies files) → detect this from stream events
- On detecting write intent: pause briefly, create worktree, update session, continue
- Actually — simpler: if thread has a `!build` or `!frontend` command, create worktree immediately. If not, don't create one. Review and question threads don't need worktrees.

**Test:** `!review PR #123` → no worktree created, Claude reads from repo root. `!build fix auth` → worktree created immediately.
**Defers:** Automatic detection of write intent (stick with command-based for now).

### Iteration 3: Cleanup and dirty detection (~30 min)

**What it adds:**
- `isWorktreeDirty(worktreePath)` — runs `git status --porcelain` in worktree
- `listWorktrees(repoPath)` — lists all slack-* worktrees with age
- Cleanup function: for each stale worktree (>24h), if clean → remove, if dirty → return list of dirty ones
- Integration with session cleanup (session-management.md iteration 3): when session is cleaned, worktree is cleaned too
- Warning message to Slack thread before removing dirty worktree

**Test:** Create worktree, make it dirty (uncommitted file). Run cleanup. Get warning instead of deletion. Create clean worktree older than timeout. Gets removed.
**Defers:** Automatic commit-and-push of dirty worktrees, branch preservation.

### Iteration 4: Custom base ref (~20 min)

**What it adds:**
- `!branch staging` command → create worktree from `origin/staging` instead of `origin/main`
- `!branch feature/xyz` → branch from specific ref
- Validate ref exists before creating (`git rev-parse --verify`)
- Error message if ref doesn't exist

**Test:** `!branch staging` then `!build` → worktree branched from staging. `!branch nonexistent` → error message in thread.
**Defers:** WorktreeCreate hook integration.

## Shortcuts

| Shortcut | Replaced in |
|---|---|
| Only command-based worktree creation (no auto-detect) | Iteration 2 decision — staying with commands |
| Hardcoded repo list | Post-MVP (config file or env) |
| execSync for git operations | Post-MVP (async exec if blocking becomes an issue) |

## Cut List (true v2)

- Auto-detect write intent from stream events (create worktree on first Edit/Write)
- WorktreeCreate hook for custom git logic
- Worktree templates (pre-configured .env, node_modules symlink)
- Worktree sharing between threads (multiple threads, same worktree)
- Auto-commit on stale cleanup (commit dirty changes to branch before removing)
- PR creation from worktree (`/pr` command → `gh pr create` from worktree branch)
