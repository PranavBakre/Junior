# Code Index: Bug Pipeline Worktrees

This module manages the lifecycle of git worktrees created in target repositories to provide code isolation for Slack threads.

## Key Files

- [manager.ts](file:///Users/psbakre/Projects/junior/src/worktree/manager.ts): Core logic for `git worktree add`, `remove`, and `prune`.
- [types.ts](file:///Users/psbakre/Projects/junior/src/worktree/types.ts): `RepoConfig` and worktree state interfaces.

## Worktree Layout

Worktrees are created at:
`<repo-path>.junior-worktrees/slack-<threadId>`

This keeps them sibling to the original repository but clearly separated.

## Lifecycle

1. **Acquire**: When a thread first touches a repo, `WorktreeManager` creates the worktree and runs the optional `worktreeSetupCommand`.
2. **Cleanup**: Stale worktrees (inactive for 24h) are pruned by the `cleanup` script to save disk space.
