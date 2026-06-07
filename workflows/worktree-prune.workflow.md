---
name: worktree-prune
enabled: true
description: Prune merged local git worktrees, migrate useful learnings into the main checkout, and report skipped worktrees.
ownerSlackUserIds:
  - U03PNSJ33S5
triggers:
  - type: schedule
    cron: "53 4 * * *"
    timezone: Asia/Kolkata
  - type: command
    command: worktree-prune
outputs:
  - type: docs
    path: data/workflow-runs/worktree-prune
permissions:
  tools:
    - git
    - docs.write
runner:
  provider: default
  agentName: default
  timeoutMs: 1200000
  idleTimeoutMs: 300000
  maxIdleInterrupts: 3
concurrency: skip
---

Prune stale local git worktrees across the configured Junior repos.

Use the runtime context as the source of truth for repositories and their absolute paths. For each repo with a usable local git checkout:

1. Establish the protected primary checkout and default branch.
   - Use the repo path from runtime context as the primary checkout. Never delete or move this directory.
   - Normalize `repo.defaultBase` before fetching or resolving it. If it starts with `origin/`, treat that full value as the preferred base ref and fetch only its branch part from the remote, e.g. `origin/main` means fetch `main`. Otherwise prefer `origin/<base>`, then the local `<base>` branch.
   - If `repo.defaultBase` is missing, try `main` and then `master` with the same remote-first resolution. Never construct refs like `origin/origin/main`.
2. Enumerate worktrees with `git worktree list --porcelain` from the primary checkout.
   - Run `git worktree prune` first to remove stale metadata for already-missing paths.
   - Skip the primary checkout.
   - Skip locked worktrees, worktrees whose path no longer exists after pruning, and worktrees currently used by an active process.
3. Only prune a worktree when its checked-out HEAD is already contained in the default branch.
   - Treat a worktree as merged only when `git merge-base --is-ancestor <worktree HEAD> <base ref>` succeeds.
   - Do not delete unmerged branches, detached reviews, or unknown HEADs just because their working tree is clean.
4. Inspect working-tree changes before removal.
   - A clean merged worktree can be removed.
   - A merged worktree with only ignorable local artifacts can be removed. Ignorable artifacts are `.DS_Store`, `.claude/**`, `.codex/**`, and empty directories left behind by those artifacts.
   - If the only meaningful changed file is `learnings.md`, migrate any durable, non-duplicative knowledge into the primary checkout's `learnings.md`, then remove the worktree if the remaining changes are only ignorable artifacts.
   - If `learnings.md` already exists in the primary checkout, preserve its structure and append or merge only genuinely new lessons. If it does not exist, create it.
   - Do not copy secrets, raw logs, temporary command output, credentials, personal data, or transient chatter from a worktree `learnings.md`.
   - If there are any other modified, deleted, staged, untracked, or ignored files that are not explicitly allowed above, skip the worktree and report the paths.
5. Remove only safe worktrees.
   - Prefer `git worktree remove <path>`.
   - Use `--force` only when the worktree is merged and all remaining changes are limited to the allowed ignorable artifacts or already-migrated `learnings.md`.
   - After removing worktrees, run `git worktree prune` again.
6. Treat learnings migration as a repository change, not as an invisible side effect.
   - If the primary checkout's `learnings.md` changed, leave the file modified in the primary checkout and call that out in the final summary with the exact path.
   - Do not commit, push, or open a PR from this workflow. The operator should review migrated knowledge first.

Return a compact Slack-ready summary with:

- repos inspected
- worktrees removed, grouped by repo
- learnings migrated, including the target `learnings.md` path
- worktrees skipped and the exact reason
- any command failures that affect trust in the cleanup

Safety rules:

- Never remove the primary checkout from runtime context.
- Never remove locked worktrees.
- Never remove worktrees whose HEAD is not already merged into the default branch.
- Never destroy unreviewed meaningful local changes.
- Never run broad `rm -rf` cleanup as a substitute for `git worktree remove`.
