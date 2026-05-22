---
name: worklog
enabled: true
description: Track PRs and commits from the last 24 hours, save a grouped worklog, and post a Slack summary.
ownerSlackUserIds: []
triggers:
  - type: schedule
    cron: "00 18 * * 1-5"
    timezone: Asia/Kolkata
  - type: command
    command: worklog
outputs:
  - type: docs
    path: data/workflow-runs/worklog
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
  timeoutMs: 300000
concurrency: skip
---

Collect my work activity from the last 24 hours across all configured Junior repos.

Use the runtime context supplied by Junior to find the configured repositories and their absolute paths.
For each repo:

1. Only report work that landed on `main`. Ignore feature branches, draft PRs, open PRs, unmerged commits, and local-only commits.
2. Use merged PRs as the primary source of truth. Query GitHub for PRs authored by `pranav-growthx`, merged into base branch `main`, and merged in the last 24 hours. Use the authenticated `gh` user only for API access, not as the author filter.
3. Use local git commits only as evidence to discover the merged PR that introduced them into `main`. If you find authored commits on `main`, map them back to the merge PR or squash PR and summarize the PR, not the individual commits. Do not include raw commit bullets unless no merged PR can be identified.
4. For commit fallback, include commits authored by `pranav-growthx`, `Pranav Bakre`, or `pranav@growthx.club`; do not use service-account local git config such as `gxt-admin` as the target author.
5. Treat collection failures as partial data, not as a reason to invent activity.

Group the work into meaningful things I did, not raw chronological noise.
Prefer product or workflow names when they are clear from PR titles, PR descriptions, or linked issue context.

The Slack summary should be compact and shaped like an operational update:

- Use section headings for major areas of work.
- Use short bullets for outcomes, not implementation trivia.
- Do not prefix every bullet with `:white_check_mark:`. The whole worklog is about completed merged work; use plain bullets by default.
- Mention PR numbers when useful, especially when a section has multiple related PRs.
- Include collection notes only when they materially affect trust in the summary. Do not include "no matching commits" notes for repos with no relevant merged PRs.
- If GitHub PR collection fails, say which repos failed and why in one compact note.

Return the final Slack-ready summary as your final response. Junior will write that response to the workflow artifact and post it to configured Slack outputs.
