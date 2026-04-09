# Code Index: Worktree Manager

## Files

| File | Purpose |
|---|---|
| `src/worktree/manager.ts` | Creates, removes, and checks git worktrees in target repos |

## Key Exports

### `src/worktree/manager.ts`
- `WorktreeManager` class:
  - `constructor(repos: RepoConfig[])` — takes repo configs with `{ name, path, defaultBase }`
  - `create(repoName, threadId): Promise<string>` — creates worktree at `{repoPath}/.worktrees/slack-{threadId}` on branch `slack/{threadId}` from `defaultBase`. Returns worktree path.
  - `remove(worktreePath): Promise<void>` — force-removes worktree and prunes
  - `exists(worktreePath): Promise<boolean>` — checks if worktree directory exists
  - `isDirty(worktreePath): Promise<boolean>` — runs `git status --porcelain` to check for uncommitted changes
  - `getRepo(repoName): RepoConfig | undefined` — looks up repo by name

## Worktree Layout

```
target-repo/
  ├── .worktrees/
  │     ├── slack-1234567890.123456/    ← thread A's isolated copy
  │     └── slack-9876543210.654321/    ← thread B's isolated copy
  ├── src/
  └── ...
```

Branch naming: `slack/{threadId}` (e.g., `slack/1234567890.123456`)

## Integration

Created by `SessionManager` when a `!build` or similar command targets a repo. The worktree path is stored in `session.worktreePath` and passed to `spawnClaude()` as the `cwd`.

Cleanup: `cleanupStaleSessions()` should check `isDirty()` before `remove()` — dirty worktrees with uncommitted work should warn, not silently delete.
