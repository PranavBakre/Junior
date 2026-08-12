---
name: slack-archive-maintenance
enabled: true
description: Synchronize all public and approved Slack history, embed changed messages, and atomically republish the ANN index.
nativeHandler: slack-archive-maintenance
ownerSlackUserIds: []
triggers:
  - type: schedule
    cron: "17 3 * * 0"
    timezone: Asia/Kolkata
  - type: command
    command: slack-archive-maintenance
outputs:
  - type: docs
    path: data/workflow-runs/slack-archive-maintenance
permissions:
  tools:
    - slack.read
    - archive.write
    - docs.write
concurrency: skip
---

Native implementation: `runSlackArchiveMaintenance()` in
`src/slack/archive-maintenance.ts`. This body is documentation only and is not
sent to an agent or model.
