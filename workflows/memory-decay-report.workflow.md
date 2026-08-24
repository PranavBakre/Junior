---
name: memory-decay-report
enabled: true
description: Report low-value stale claims without archiving them
ownerSlackUserIds: []
triggers:
  - type: schedule
    cron: "18 6 * * 1"
    timezone: Asia/Kolkata
  - type: command
    command: memory-decay-report
outputs:
  - type: docs
    path: data/workflow-runs/memory-decay-report
permissions:
  tools:
    - docs.write
    - memory.read
    - memory.write
    - memory.evaluate
nativeHandler: memory-decay-report
concurrency: skip
---

Report the current stale-and-low-value claim candidates using the owned memory
archive thresholds. This workflow is report-first and never archives claims.
After reviewing the artifact, an operator must explicitly run
`bun run src/memory/cli.ts archive-stale --apply` to archive candidates. Claims
are archived (never deleted) only when both age and value thresholds match;
provenance remains intact.
