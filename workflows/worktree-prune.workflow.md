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

Start by running Junior's deterministic pruner exactly once:
`bun run <runtime junior.projectRoot>/scripts/worktree-prune.ts`.
For a GitHub merge-triggered run, pass the matching configured repo and branch
as `--repo <name> --branch <branch>`. Use the script's result as the source of truth for
enumeration, merged/clean classification, and removal; do not repeat those
Git checks manually. The script intentionally skips worktrees that need
preservation review (including ignored dotenv files) instead of risking data.
Only handle those exceptional skips, stale-worktree PR context, and the final
Slack report in this workflow.

For merge-triggered runs, resolve the event owner/repo only against the exact
case-insensitive `repo.githubRepo`, then pass that configured repo and branch to
the script. Do not broaden the run. The script conservatively skips all
meaningful dirty state, locked, unmerged, missing, dev-server, and dotenv-bearing
worktrees. PNG artifacts and `next-env.d.ts` are treated as harmless generated
residuals.

After it finishes, use the script output directly in a compact Slack-ready
summary: repos inspected, removals, skips with reasons, and failures. Do not
manually re-classify its worktrees. For any surviving worktree older than seven
days, add its GitHub PR (open, draft, closed, or merged) when available; if
there is no PR, give one evidence-backed short feature phrase. Never commit,
push, delete branches, or use broad filesystem deletion.
