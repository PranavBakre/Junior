---
name: web-activity-report
enabled: true
description: Daily web activity digest covering engagement, community, members, and health metrics from Mixpanel, Convex, and New Relic.
ownerSlackUserIds: []
nativeHandler: web-activity-report
triggers:
  - type: schedule
    cron: "0 9 * * *"
    timezone: Asia/Kolkata
  - type: command
    command: web-report
outputs:
  - type: docs
    path: data/workflow-runs/web-activity-report
  - type: slack
    channel: C0338BCK1UL
permissions:
  tools:
    - docs.write
    - slack.post
concurrency: skip
---

Daily web activity report for gx-client-next and gx-community.
Pulls from Mixpanel (web events), Convex (community + member metrics), and New Relic (performance/health).
Posts at 9:00 AM IST covering the previous day's data.
