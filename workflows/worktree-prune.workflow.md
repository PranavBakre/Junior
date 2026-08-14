---
name: worktree-prune
enabled: true
description: Prune merged local git worktrees, migrate useful learnings into the main checkout, and report skipped worktrees.
ownerSlackUserIds:
  - U03PNSJ33S5
triggers:
  - type: schedule
    cron: "00 7 * * *"
    timezone: Asia/Kolkata
  - type: command
    command: worktree-prune
outputs:
  - type: docs
    path: data/workflow-runs/worktree-prune
  - type: slack
    channel: C0AKSPQ4CBH
permissions:
  tools:
    - git
    - gh
    - docs.write
    - slack.post
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

When `run.triggerContext.source` is `github.pr.merged`, limit the run to the
listed `pullRequests`: inspect only the matching repo and worktree branch for
each entry. Match the event's `owner/repo` only against `repo.githubRepo`,
case-insensitively; never infer a match from the local repo name, path,
basename, or head SHA. Verify the worktree HEAD matches the supplied `headSha` before
removal. If the branch has no registered local worktree, report that compactly
and do not broaden the event-triggered run into a full sweep. Scheduled and
manually triggered runs without this context continue to inspect every repo.

1. Establish the protected primary checkout and default branch.
   - Use the repo path from runtime context as the primary checkout. Never delete or move this directory.
   - Normalize `repo.defaultBase` before fetching or resolving it. If it starts with `origin/`, treat that full value as the preferred base ref and fetch only its branch part from the remote, e.g. `origin/main` means fetch `main`. Otherwise prefer `origin/<base>`, then the local `<base>` branch.
   - If `repo.defaultBase` is missing, try `main` and then `master` with the same remote-first resolution. Never construct refs like `origin/origin/main`.
2. Enumerate worktrees with `git worktree list --porcelain` from the primary checkout.
   - Confirm the output is actual porcelain records beginning with fields such as `worktree` and `branch`. If a local command wrapper reformats the output, bypass it and invoke the system Git binary directly for all machine-readable checks.
   - Skip the primary checkout.
   - Skip every dev-server slot, including branches or paths named `dev-server-slot/<repo>` or `slack-dev-server`. Never deregister, remove, or recreate one during this workflow.
   - Skip locked worktrees, worktrees whose path no longer exists, and worktrees currently used by an active process.
   - Do not run broad `git worktree prune`; remove only explicitly classified worktree paths with `git worktree remove`.
3. Only prune a worktree when its checked-out HEAD is already contained in the default branch.
   - Treat a worktree as merged only when `git merge-base --is-ancestor <worktree HEAD> <base ref>` succeeds.
   - Do not delete unmerged branches, detached reviews, or unknown HEADs just because their working tree is clean.
4. Inspect working-tree changes before removal.
   - Complete every preservation check for a worktree before running its removal command. This is a strict per-worktree phase barrier: if `.env` discovery, parsing, copying, or verification emits any warning or error, do not remove that worktree.
   - A clean merged worktree can be removed.
   - Define meaningful changes with normal Git status, without `--ignored`. A merged worktree with only ignored local artifacts can be removed after applying the `.env` preservation rule below. Typical ignored artifacts include `.env*`, `node_modules/**`, `.next/**`, build output, `tsconfig.tsbuildinfo`, local tool configuration, `.DS_Store`, `.claude/**`, and `.codex/**`.
   - Independently enumerate ignored `.env` and `.env.*` files before removal, because normal Git status intentionally hides them. Compare their variable names with the corresponding file at the same relative path in the primary checkout. If the worktree has variables absent from the primary file, copy the exact source assignment text into the primary file first, creating the corresponding primary file when needed. Support ordinary dotenv forms such as optional `export`, surrounding whitespace, quoted values, and empty values; if the complete assignment cannot be identified safely, skip the worktree. Preserve existing primary values and never print secret values in logs or summaries.
   - Before removal, re-read both source and target `.env` files and verify every migrated variable exists in the target with a value equivalent to its source assignment. Do not rely on another file or a guessed replacement value. If exact source-to-target equivalence cannot be proven while the source worktree still exists, skip the worktree. Never remove first and attempt recovery afterward.
   - Treat this `.env` migration as a primary-checkout change: leave the target file modified for operator review, report its exact path and the copied variable names, and do not commit or push it.
   - If the only meaningful changed file is `learnings.md`, migrate any durable, non-duplicative knowledge into the primary checkout's `learnings.md`, then remove the worktree if the remaining changes are only ignorable artifacts.
   - If `learnings.md` already exists in the primary checkout, preserve its structure and append or merge only genuinely new lessons. If it does not exist, create it.
   - Do not copy secrets, raw logs, temporary command output, credentials, personal data, or transient chatter from a worktree `learnings.md`.
   - If there are any other modified, deleted, staged, or untracked files that are not explicitly allowed above, skip the worktree and report the paths.
5. Remove only safe worktrees.
   - Prefer `git worktree remove <path>`.
   - Use `--force` only when the worktree is merged and all remaining changes are limited to the allowed ignorable artifacts or already-migrated `learnings.md`.
   - Gate any branch deletion on successful worktree removal. This workflow does not otherwise need to delete branches.
   - Verify each removal with `git worktree list --porcelain` plus a filesystem path check.
   - Re-verify that every dev-server slot remains registered after removals.
6. Treat learnings migration as a repository change, not as an invisible side effect.
   - If the primary checkout's `learnings.md` changed, leave the file modified in the primary checkout and call that out in the final summary with the exact path.
   - Do not commit, push, or open a PR from this workflow. The operator should review migrated knowledge first.
7. Report surviving stale worktrees to Slack.
   - After removals and verification, inspect every surviving secondary worktree except the protected primary checkout, dev-server slots, and worktrees with an active process.
   - Treat a worktree as untouched for seven days only when its newest trustworthy activity is older than the run time minus seven days. Compute newest activity as the maximum of: worktree registration/creation metadata time, checked-out HEAD commit time, and modification times of meaningful tracked or untracked files. Exclude ignored dependencies, build output, caches, logs, and local tooling artifacts from the file-activity signal. Do not use metadata that this inspection itself refreshes.
   - First look for a GitHub PR associated with the worktree branch or checked-out HEAD, including open, draft, closed, and merged PRs. Query GitHub rather than inferring from local names. If a PR exists, report its linked PR number, title, and state; do not separately infer or describe the feature.
   - If no PR exists, summarize the feature in one short phrase using the branch name, branch-only commits, and meaningful local diff. Never invent a feature; use `feature unclear` plus the branch or abbreviated HEAD when the evidence is ambiguous.
   - Include the repo, absolute worktree path, last trustworthy activity date, and either the PR or feature for each stale worktree. Group entries by repo under a `Stale worktrees (>7 days)` heading.
   - If GitHub lookup fails for a worktree, fall back to feature inference but mark the PR lookup failure compactly so the report's trust is clear.

Return a compact Slack-ready summary with:

- repos inspected
- worktrees removed, grouped by repo
- learnings migrated, including the target `learnings.md` path
- `.env` variables migrated, including target paths and variable names but never values
- worktrees skipped and the exact reason
- surviving worktrees untouched for more than seven days, with a PR link when one exists and otherwise a concise feature
- any command failures that affect trust in the cleanup

Safety rules:

- Never remove the primary checkout from runtime context.
- Never remove locked worktrees.
- Never remove worktrees whose HEAD is not already merged into the default branch.
- Never destroy unreviewed meaningful local changes.
- Never run broad `rm -rf` cleanup as a substitute for `git worktree remove`.
