# Worktree Manager

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
- Support custom base ref per thread (`/branch staging`)

## Dependencies

- Session Manager (feature: [session-management.md](session-management.md)) — stores worktree path
- Git installed on the host
- Target repos cloned locally with fetch access

## Configuration

```typescript
interface RepoConfig {
  name: string; // "example-backend"
  path: string; // "~/Projects/example-backend"
  defaultBase: string; // "origin/main"
  worktreeDir: string; // ".claude/worktrees" (relative to repo root)
}

// configured via env or config file
const repos: RepoConfig[] = [
  {
    name: "example-backend",
    path: "~/Projects/example-backend",
    defaultBase: "origin/main",
    worktreeDir: ".claude/worktrees",
  },
  {
    name: "example-frontend",
    path: "~/Projects/example-frontend",
    defaultBase: "origin/main",
    worktreeDir: ".claude/worktrees",
  },
];
```

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
- Default repo configurable, overridable with `/repo example-frontend`

**Test:** `/build fix auth` → worktree created in example-backend, Claude runs in that worktree. Second message in same thread → same worktree reused. `/repo example-frontend` then `/build` → worktree in example-frontend instead.
**Defers:** Deferred creation, cleanup, custom base ref.

### Iteration 2: Deferred creation (~30 min)

Don't create worktrees eagerly. Only create when Claude actually needs to write files.

**What it adds:**
- Threads start without a worktree (Claude runs in target repo root, read-only effectively)
- If Claude's first tool call is `Edit`, `Write`, or `Bash` (that modifies files) → detect this from stream events
- On detecting write intent: pause briefly, create worktree, update session, continue
- Actually — simpler: if thread has a `/build` or `/frontend` command, create worktree immediately. If not, don't create one. Review and question threads don't need worktrees.

**Test:** `/review PR #123` → no worktree created, Claude reads from repo root. `/build fix auth` → worktree created immediately.
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
- `/branch staging` command → create worktree from `origin/staging` instead of `origin/main`
- `/branch feature/xyz` → branch from specific ref
- Validate ref exists before creating (`git rev-parse --verify`)
- Error message if ref doesn't exist

**Test:** `/branch staging` then `/build` → worktree branched from staging. `/branch nonexistent` → error message in thread.
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
