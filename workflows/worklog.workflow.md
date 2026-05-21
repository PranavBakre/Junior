---
name: worklog
enabled: true
description: Track PRs and commits from the last 24 hours, save a grouped worklog, and post a Slack summary.
ownerSlackUserIds: []
triggers:
  - type: schedule
    cron: "0 19 * * 1-5"
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

Collect my PR and commit activity from the last 24 hours across all configured Junior repos.

Use the runtime context supplied by Junior to find the configured repositories and their absolute paths.
For each repo:

1. Inspect local commits with `git log` from the last 24 hours, using the repo's local git author config when available.
2. Inspect GitHub PR activity with `gh`; resolve the authenticated GitHub login if needed and include PRs authored by that login that were updated in the last 24 hours.
3. Treat collection failures as partial data, not as a reason to invent activity.

Group the work into meaningful things I did, not raw chronological noise.
Prefer product or workflow names when they are clear from PR titles or commit subjects.

The Slack summary should be compact and shaped like an operational update:

- Use section headings for major areas of work.
- Use short bullets for specific shipped or reviewed items.
- Mark clearly completed items with `:white_check_mark:` when the evidence supports it.
- Include collection errors only when they affect trust in the summary.

Return the final Slack-ready summary as your final response. Junior will write that response to the workflow artifact and post it to configured Slack outputs.
