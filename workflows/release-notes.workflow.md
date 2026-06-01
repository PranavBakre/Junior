---
name: release-notes
enabled: true
description: Create weekly draft GitHub Releases across all configured repos/apps from merged PRs.
ownerSlackUserIds: []
triggers:
  - type: schedule
    cron: "0 18 * * 5"
    timezone: Asia/Kolkata
  - type: command
    command: release-notes
outputs:
  - type: docs
    path: data/workflow-runs/release-notes
permissions:
  tools:
    - git
    - gh
    - docs.write
runner:
  provider: default
  agentName: default
  timeoutMs: 1200000
  idleTimeoutMs: 300000
  maxIdleInterrupts: 3
concurrency: skip
---

Create weekly draft GitHub Releases across all configured Junior repos/apps.

Use the runtime context as the source of truth for configured repositories, the same way the `worklog` workflow does. Iterate every configured repo/app with a local path. Do not hard-code `gx-backend` or any other single repository.

Cadence: every Friday at 6:00 PM Asia/Kolkata. The workflow can also be run manually with `!release-notes`.

Expected work for each configured repo/app:

1. Identify the repository:
   - Use the repo name and absolute path from runtime context.
   - Skip entries without a usable local git repo and report the skip reason.
   - Derive the GitHub `owner/repo` from `origin` when possible; if that fails, use `gh repo view --json nameWithOwner` from inside the repo.
2. Ensure the local repo has fresh tags and main history:
   - Fetch the default/base branch and tags with pruning.
   - Prefer the configured default base from runtime context when present; otherwise use `origin/main`, then `origin/master` as fallback.
3. Find the latest existing release/tag for that repo:
   - Prefer `gh release list --repo <owner/repo> --limit 1 --json tagName,createdAt,isDraft,isPrerelease`.
   - If no release exists, use the newest git tag by creator date.
   - If no tag exists, use the first commit on the default/base branch.
4. Collect changes merged after that point:
   - Prefer merged PRs from GitHub filtered to the default/base branch and after the last release/tag date when available.
   - Include PR number, title, body summary, labels, merge date, author, and changed files.
   - If PR lookup is incomplete, fall back to `git log <last-ref>..<base-ref> --first-parent` and map merge/squash commits back to PRs where possible.
5. If a repo has no meaningful product/code changes, do not create a release for that repo. Record the no-release reason in the final summary.
6. Generate concise release notes per repo:
   - Use only sections that have entries: `## Added`, `## Changed`, `## Fixed`, `## Removed`.
   - Each entry should be one bullet: `- **Short title** — One-line description`.
   - Combine related PRs into one bullet when they belong to the same feature.
   - Skip routine CI/tooling/doc-only changes unless they materially affect the team.
   - Do not include commit hashes. Include PR numbers only when they help reviewers trace the change.
7. Create a draft GitHub Release for each repo with meaningful changes, never publish it automatically:
   - Tag format: `YYYY-MM-DD` in Asia/Kolkata for the workflow run date.
   - If that tag or release already exists in that repo, append `.2`, `.3`, etc.
   - Use `gh release create <tag> --repo <owner/repo> --title "Release <tag>" --notes-file <notes-file> --draft --target <base-branch>`.
8. Return a compact run summary grouped by repo/app:
   - release tag created, or no-release/skip reason
   - number of PRs included
   - GitHub release URL when created
   - any collection limitations or manual follow-ups

Safety rules:

- Do not edit repository files.
- Do not publish releases.
- Do not close, merge, or modify PRs.
- Do not require `ANTHROPIC_API_KEY`; the workflow runner itself writes the notes.
- Treat collection failures as partial data. Continue with other configured repos/apps instead of failing the whole run when one repo errors.
