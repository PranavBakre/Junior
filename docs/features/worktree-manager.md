# Worktree Manager

> **Current status (2026-07-21):** Shipped. Worktrees are sibling directories under `<repo>.junior-worktrees/`; delegated setup commands receive `branch --path <abs> --base <ref>`.

> **Two flows live here.** The single-target-repo flow (driven by `!repo <name>`) creates one worktree per thread at `session.worktreePath`. The bug-pipeline flow (lead-driven) creates one worktree per routed repo per thread at `session.worktreePaths[repo]`, plus a dedicated dev-server worktree per repo at a fixed path. See [bug-pipeline-worktrees.md](bug-pipeline-worktrees.md) for the full bug-pipeline design and [process-lifecycle.md](process-lifecycle.md) for the dev-server lifecycle that owns the dev-server worktree.

## Problem

When a Slack thread needs to edit code in a target repo (example-backend, example-frontend), it needs its own git worktree so concurrent threads don't collide on file state. The worktree manager creates, tracks, and cleans up worktrees in target repos — not in junior's own workspace.

**Who has this problem:** Any thread that does code work on a shared repo.
**What happens today:** Threads with a target repo receive sibling worktrees;
bug-pipeline intake can register one per routed repo, and the dev-server manager
owns a dedicated sibling slot. Session cleanup does not remove worktrees yet;
explicit removal is forceful, so callers must dirty-check first. This preserves
both clean and dirty worktrees after a stale session row is deleted.
**Painful part:** Worktree lifecycle. Creating is easy. Knowing when to create (not every thread needs one), cleaning up safely (check for uncommitted changes), and handling edge cases (stale branches, dangling worktrees from crashed processes) is hard.
**"Finally" moment:** Two Slack threads edit example-backend simultaneously. Neither sees the other's changes. Both can commit and push independently.

## Full Vision

- Create worktrees in target repos on demand
- Branch naming: `slack/<threadId>` from configurable base ref (default `origin/main`)
- Track worktree path per session
- Deferred creation: only create when thread actually needs to edit code
- Check worktree exists before resuming (may have been cleaned up)
- Check stale worktrees for cleanup, but keep them on disk until an explicit
  caller performs the dirty-check and removal (automatic session cleanup does
  not currently remove worktrees)
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
  githubRepo?: string;                // exact "owner/repo" for PR URL routing
  githubUser?: string;                // local gh account used for this repo
  // Optional — bug-pipeline / dev-server fields:
  worktreeSetupCommand?: string;      // target-repo command, resolved relative to `path`, receiving branch/--path/--base
  devCommand?: string;                // e.g. "pnpm dev", "npm run dev" — split on whitespace, no shell
  devPort?: number;                   // e.g. 3000, 8000 — readiness probe target
  readyUrl?: string;                  // e.g. "http://localhost:3000" — defaults to localhost:<devPort>
}
```

The bug-pipeline + dev-server fields are optional. Repos that only need the `!repo` flow can leave them unset; repos that participate in the bug pipeline set them per [bug-pipeline-worktrees.md](bug-pipeline-worktrees.md).

## Public API (current)

`WorktreeManager` (`src/worktree/manager.ts`):

- `createWorktree(repoName, threadId, baseRef?, branchOverride?) → Promise<worktreePath>` — creates a worktree at `<repo.path>.junior-worktrees/slack-<threadId>` (or whatever path `getWorktreePath` derives — note this is a sibling directory to the repo, deliberately outside `.claude/`). The new branch is `branchOverride ?? slack/<threadId>`; the starting ref is `baseRef ?? repo.defaultBase`. If `repo.worktreeSetupCommand` is set, the manager runs `<repo.path>/<command> <worktreePath> <branch>` instead of `git fetch + git worktree add`.
- `syncRepo(repoName) → Promise<void>` — refreshes `origin/*` from the configured checkout before any reused managed worktree is handed to a runner. Pipeline dispatch refreshes every reused repo; ordinary `!repo` and inferred-review turns refresh their selected repo. Sandboxed providers cannot update the shared Git metadata behind linked worktrees, so this pre-turn fetch belongs to Junior rather than the model process.
- GitHub CLI/API operations require both the exact configured `githubRepo` and
  `githubUser`. Junior resolves that account with `gh auth token --user`,
  verifies it with `gh api user`, and applies the resulting `GH_TOKEN` only to
  that repo's worktree setup, runner, and GitHub API child processes. Each
  `gh` child gets an isolated `GH_CONFIG_DIR`; inherited GitHub tokens and
  account/config selectors are removed. Unknown repos or repos without
  `githubUser` fail closed rather than using the host's active `gh` account.
- Delegated setup requires 2 GiB of free filesystem headroom by default (`WORKTREE_SETUP_MIN_FREE_BYTES` overrides it). Junior streams stdout and stderr concurrently into a restricted transcript while retaining only bounded tails in memory, so verbose installers cannot deadlock on full pipes or exhaust the bot heap. If the setup script fails after registering a worktree, Junior transactionally removes that worktree and its new branch; the surfaced error is a bounded per-stream tail plus a pointer to the complete owner-only (`0600`) transcript under `logs/worktree-setup/`.
- Every Git command and delegated setup script runs in its own process group with
  a hard wall-clock bound. Git defaults to 30 seconds
  (`WORKTREE_GIT_TIMEOUT_MS`); setup defaults to 15 minutes
  (`WORKTREE_SETUP_TIMEOUT_MS`). On expiry Junior terminates the entire group,
  force-kills it after `WORKTREE_TERMINATION_GRACE_MS` (1 second default), and
  cancels pipe readers so a grandchild holding stdout/stderr cannot keep the
  Slack turn alive. These processes are always noninteractive:
  `GIT_TERMINAL_PROMPT=0`, batch-mode SSH, and suppressed inherited credential
  helpers prevent credential prompts from becoming hangs. For a repo with a
  verified `GH_TOKEN`, Junior supplies GitHub HTTPS credentials through a
  temporary 0700 askpass helper (`x-access-token` plus the token), then removes
  the helper after the bounded process exits. `GH_TOKEN` alone is not consumed
  by Git's HTTPS transport. Repos without a verified token use a host-valid
  false askpass executable and fail fast.
- `removeWorktree(repoName, threadId, { force? }) → Promise<void>` — reads the actual current branch via `git -C <wt> branch --show-current` before deletion (so cleanup works for `branchOverride` callers), removes the worktree (forcefully by default; safe cleanup passes `force: false` so Git gets a final dirty-worktree guard), and `git branch -D`s the branch. It then verifies both the Git worktree registry and filesystem path are gone; a non-atomic leftover raises an incomplete-cleanup error with the path for preservation review. Branch lookup and deletion remain non-fatal for missing/detached state.
- `worktreeExists(repoName, threadId) → Promise<boolean>` and `isWorktreeDirty(worktreePath) → Promise<boolean>` — used by cleanup.
- `getWorktreePath(repoName, threadId) → string` and `getBranchName(threadId) → string` — pure helpers (no I/O).

The MCP tool `mcp__slack-bot__register_worktree({ thread_id, repo, branch? })` (in `src/mcp/slack-server.ts`) wraps `createWorktree` for lead's intake and persists the resulting path into `session.worktreePaths[repo]` via the session store using the refetch-then-mutate pattern.

The signed MCP tool `mcp__slack-bot__unregister_worktree({ repo, discard_changes? })`
is the matching teardown path. It is bound to the authenticated current Slack
thread, checks the registered worktree for tracked/untracked changes, ignored
dotenv files, and unpushed commits, then calls `removeWorktree` and removes only
that repo from the session's worktree fields. Preservation-sensitive state is
refused by default. `discard_changes: true` is an explicit destructive override
that agents may use only after a human confirms permanent deletion. The
`worktree-mutate` capability exposes this tool to Junior without granting it to
read-only workers.

## Deterministic prune script

`scripts/worktree-prune.ts` is the programmatic cleanup path used by the
`worktree-prune` workflow. It loads `REPOS` and calls
`src/worktree/prune.ts`, which fetches and resolves each configured default
base, parses porcelain worktree records, and removes only secondary worktrees
that are unlocked, present, merged, free of meaningful changes, and free of
ignored dotenv files.
It never deletes branches and reports every skip or command failure. Ignored
dotenv files, meaningful visible changes, and any other preservation-sensitive
state stay for the workflow's small review/reporting phase. Untracked or
modified PNG artifacts and `next-env.d.ts` are treated as generated residual
state and do not block removal once the worktree is otherwise safe and merged.

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
