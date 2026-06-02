# Code Index: Bug Pipeline Worktrees

This index ties the bug-pipeline worktree behavior to the worktree manager, session state, Slack MCP registration, and dev-server queue.

## Code Index

| Symbol | File | Purpose |
|---|---|---|
| `WorktreeManager.createWorktree(...)` | `src/worktree/manager.ts` | Creates per-thread target-repo worktrees inline or via `worktreeSetupCommand`. |
| `WorktreeManager.getWorktreePath(...)` | `src/worktree/manager.ts` | Resolves `<repo.path>.junior-worktrees/slack-<threadId>`, outside the repo. |
| `ThreadSession.worktreePaths` | `src/session/types.ts` | Stores per-repo worktree paths for multi-repo bug threads. |
| `buildWorkspaceBlock(...)` | `src/slack/thread-context.ts` | Injects single- or multi-repo workspace safety rules into runner prompts. |
| `register_worktree` | `src/mcp/slack-server.ts` | Lets a runner claim/create a repo worktree for the current Slack thread. |
| `DevServerQueue.acquire(...)` | `src/lifecycle/dev-server-queue.ts` | Serializes shared dev-server slots across threads. |

## Worktree Layout

Worktrees are created at:
`<repo-path>.junior-worktrees/slack-<threadId>`

This keeps them sibling to the original repository. They are deliberately not placed under `.claude/`, because target-repo setup scripts may copy `.claude/` recursively.

## Lifecycle

1. **Acquire**: When a target-repo thread or `register_worktree` first needs a repo, `WorktreeManager` creates the worktree and runs the optional `worktreeSetupCommand`.
2. **Use**: `SessionManager` runs the provider from the worktree cwd; multi-repo bug threads carry all paths in `session.worktreePaths`.
3. **Dev-server slot**: `!devserver` uses the shared queue/manager rather than letting every thread own a fixed port independently.
4. **Cleanup**: `cleanupStaleSessions` deletes stale session rows only. Worktree deletion is a separate operation and must check `isWorktreeDirty()` before `removeWorktree()`.
