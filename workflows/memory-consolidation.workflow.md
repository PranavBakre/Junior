---
name: memory-consolidation
enabled: true
description: Run the offline v3 consolidation sweep — turn unconsolidated source records into episodes, entity profiles, and semantic claims.
ownerSlackUserIds: []
triggers:
  - type: schedule
    cron: "38 6 * * *"
    timezone: Asia/Kolkata
  - type: command
    command: memory-consolidation
outputs:
  - type: docs
    path: data/workflow-runs/memory-consolidation
permissions:
  tools:
    - docs.write
    - memory.read
    - memory.write
    - memory.evaluate
concurrency: skip
---

Run Junior's offline memory consolidation (memory-system-v3.md §7).

This workflow runs the **v3 consolidation sweep engine directly** — there is no
separate LLM-inspection agent pass. The executor drains unconsolidated
`memory_source_record`s, session-scoped per thread plus a final unthreaded
sweep, and for each scope spawns the consolidation runner (`claude -p`,
structured output) to derive memory, then persists it through the write gates:

- **episodes** — what happened, with provenance back to the source records;
- **entity profiles** — keyed, human-inspectable markdown for a person / repo /
  situation, merged (never duplicated) on `entity_ref`;
- **claims** — atomic lessons / facts / situation-claims, embedded locally
  (harrier) and proximity-deduped against the existing corpus before write.

Raw source records remain authoritative and are stamped consolidated exactly
once; derived memory is always rebuildable from them. The runner's structured
output is the only LLM step — the sweep does not edit database rows directly.

The workflow's artifact is the sweep summary (records processed, episodes,
profiles, and claims written/deduped per scope, plus any per-session failures).

This is an offline / operator-triggered pass (daily cron + the
`memory-consolidation` command), never the hot capture path. Do not run it on
every Slack message.
