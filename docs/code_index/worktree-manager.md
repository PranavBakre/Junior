# Code Index: Worktree Manager

Creates, removes, and inspects git worktrees in target repos for per-thread code isolation. Supports inline `git worktree add` and delegated setup scripts.

## Code Index

### src/worktree

| Symbol | File | Purpose |
|---|---|---|
| `WorktreeManager(repos)` | `manager.ts` | Constructor — keeps `RepoConfig[]` |
| `createWorktree(repoName, threadId, baseRef?, branchOverride?)` | `manager.ts` | Creates worktree. `baseRef` defaults to `repo.defaultBase`. `branchOverride` defaults to `slack/<threadId>`. Returns absolute path. |
| `removeWorktree(repoName, threadId)` | `manager.ts` | `git worktree remove --force` + `git branch -D` (queries actual branch name from the worktree first to handle `branchOverride`) |
| `worktreeExists(repoName, threadId)` | `manager.ts` | Filesystem check via `node:fs/promises.stat` |
| `isWorktreeDirty(worktreePath)` | `manager.ts` | `git status --porcelain` |
| `getWorktreePath(repoName, threadId)` | `manager.ts` | `<repo.path>.junior-worktrees/slack-<threadId>` — sibling, NOT under `.claude/` |
| `getBranchName(threadId)` | `manager.ts` | `slack/<threadId>` |
| `getRepo(name)` | `manager.ts` | Lookup in `repos` |

## Layout

```
<repo>.junior-worktrees/
  ├── slack-1234567890.123456/    ← thread A's worktree
  ├── slack-9876543210.654321/    ← thread B's worktree
  └── slack-dev-server/           ← shared dev-server worktree (DevServerManager)
```

Default branch: `slack/<threadId>` off `repo.defaultBase`.

## Setup-script delegation

When `repo.worktreeSetupCommand` is set, Junior calls the script instead of running git inline:

```
<repo.path>/<command> <branch> --path <abs> --base <ref>
```

The script owns `git fetch`, `git worktree add`, env copy, install, MCP migration. Junior always passes `--base` (defaults to `repo.defaultBase`) so worktrees are reproducible. When unset, Junior runs `git fetch origin --prune` then `git worktree add <path> -b <branch> <base>` inline.

## Key Concepts

### Sibling path, NOT under `.claude/`

Setup scripts that `cp -R .claude/.` would otherwise pull every sibling thread's worktree (and the destination itself) into the new worktree — a recursive copy. The trailing-slash strip at both config load and `getWorktreePath` is belt-and-suspenders.

### Always create a worktree

`SessionManager` creates a worktree whenever `session.targetRepo` is set — not gated on agent type. Previously gated on `build`/`frontend`, which let other agents `cwd` into the shared origin repo and modify it.

Durable pipeline assignments use a stricter path: `pipeline-routing.ts` resolves every run `repoRef`, and `SessionManager` provisions every resolved repo before spawning the worker. Concurrent fan-out creation for the same repo/thread is single-flighted. Repo-less orchestration may remain in Junior's workspace, but repo-bound pipeline agents never fall back to the target repo's developer checkout.

### Dirty-check before remove

Callers should `isWorktreeDirty(path)` before `removeWorktree` so uncommitted work isn't silently destroyed. The cleanup pass in `lifecycle/cleanup.ts` skips busy/draining and deletes only stale idle sessions; worktree removal itself is not currently automatic on cleanup (worktrees outlive the session row).

## Dependencies

- **Uses**: `config.RepoConfig`, `Bun.spawn` (git, optional setup script), `node:fs/promises` (stat)
- **Used by**: `SessionManager.runRunnerWithAgent` (per-thread and durable pipeline provisioning), `DevServerManager.bootstrap` (shared dev-server worktree), MCP `register_worktree` tool (explicit/manual routing)
