# Code Index: Worktree Manager

Creates, removes, and checks git worktrees in target repos for per-thread code isolation.

## Code Index

### src/worktree

| Function | File | Purpose |
|----------|------|---------|
| `WorktreeManager(repos)` | `manager.ts` | Constructor: takes `RepoConfig[]` with `{ name, path, defaultBase }` |
| `WorktreeManager.create(repoName, threadId)` | `manager.ts` | Creates worktree, returns path |
| `WorktreeManager.remove(worktreePath)` | `manager.ts` | Force-removes worktree and prunes |
| `WorktreeManager.exists(worktreePath)` | `manager.ts` | Checks if worktree directory exists |
| `WorktreeManager.isDirty(worktreePath)` | `manager.ts` | `git status --porcelain` — checks for uncommitted changes |
| `WorktreeManager.getRepo(repoName)` | `manager.ts` | Looks up repo config by name |

## Layout

```
target-repo/
  ├── .worktrees/
  │     ├── slack-1234567890.123456/    ← thread A's isolated copy
  │     └── slack-9876543210.654321/    ← thread B's isolated copy
  ├── src/
  └── ...
```

Branch naming: `slack/{threadId}` off `defaultBase` (e.g., `main`).

## Key Concepts

### Cleanup Safety

`isDirty()` should be checked before `remove()` — dirty worktrees with uncommitted work should warn the user, not silently delete. `cleanupStaleSessions()` in lifecycle handles this.

## Dependencies

- **Uses**: `config` (RepoConfig), git CLI (via Bun.spawn)
- **Used by**: `SessionManager` (creates on `!build`, stores path in `session.worktreePath`)
