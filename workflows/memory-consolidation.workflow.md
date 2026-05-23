---
name: memory-consolidation
enabled: true
description: Run the offline associative-memory consolidation pass and summarize memory promotions, archives, and draft rules.
ownerSlackUserIds: []
triggers:
  - type: command
    command: memory-consolidation
outputs:
  - type: docs
    path: data/workflow-runs/memory-consolidation
permissions:
  tools:
    - docs.write
runner:
  provider: default
  agentName: default
  timeoutMs: 300000
concurrency: skip
---

Run the associative-memory consolidation workflow for Junior.

Use the memory code path as the source of truth: raw source records remain authoritative, derived memories are rebuildable, and any promotion/archive/rule proposal must preserve provenance.

Expected work:

1. Inspect recent memory source records, derived events, ingestion classifications, and corrections.
2. Promote repeated corrections into routing memories only when the evidence is explicit.
3. Promote repeated high-importance patterns into lessons/facts only when source records support them.
4. Archive low-importance stale events out of active recall without deleting source records.
5. Propose draft bounded-DSL ingestion rules from repeated corrections; do not mark them accepted without review.
6. Record a compact summary of decisions: promoted memories, archived event ids, draft rule ids, and any blockers.

Do not run this on every Slack message. This is an offline/operator-triggered pass, not the hot capture path.
