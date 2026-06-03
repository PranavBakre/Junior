---
name: memory-consolidation
enabled: true
description: Run the offline associative-memory consolidation pass and summarize memory promotions, archives, and draft rules.
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
runner:
  provider: default
  agentName: default
  timeoutMs: 30000000
  idleTimeoutMs: 300000
  maxIdleInterrupts: 3
concurrency: skip
---

Run the associative-memory consolidation workflow for Junior.

Use the memory code path as the source of truth: raw source records remain authoritative, derived memories are rebuildable, and any promotion/archive/rule proposal must preserve provenance.

Access memory through the supported tool surface, not by editing database rows directly:

- CLI: `bun run <runtime context junior.memoryCli> recall --query "..." --json`
- CLI: `bun run <runtime context junior.memoryCli> consolidate --json`
- CLI: `bun run <runtime context junior.memoryCli> archive-memory --id <memory-id> --json` to remove a low-value derived memory from active recall (source records are preserved)
- MCP, when available in a normal Junior run: `memory_recall` and `memory_consolidate`

The CLI uses `MEMORY_DB_PATH` when set, otherwise `data/memory.db`. Workflow runner cwd is `/tmp/junior-utility`, so use the absolute `junior.memoryCli` path from runtime context rather than a relative `src/memory/cli.ts` path.

Expected work:

1. Inspect recent memory source records, derived events, ingestion classifications, and corrections.
2. Promote repeated corrections into routing memories only when the evidence is explicit.
3. Promote repeated high-importance patterns into lessons/facts only when source records support a reusable behavioral rule, user preference, domain fact, or operating procedure.
4. Do not promote tag-count clusters into lessons. A lesson must say what to do differently, when to apply it, and why the evidence supports it.
5. Archive low-importance stale events and low-value derived memories out of active recall without deleting source records.
6. Propose draft bounded-DSL ingestion rules from repeated corrections; do not mark them accepted without review.
7. Record a compact summary of decisions: promoted memories, archived event ids, draft rule ids, and any blockers.

Quality bar:

- Tag-based promotion is allowed only for semantic tags that describe reusable work patterns, domains, products, features, user preferences, or procedures.
- Tags may help find candidate evidence, but a promoted lesson must be backed by source bodies that explain why the pattern matters.
- Reject or flag promotions from operational/indexing tags, including `agent:*`, `runner_tool_error`, `runner_output`, `slack_message`, `error`, `command:*`, `growthx`, `gx_learnings`, `learnings`, worktree/repo labels, import labels, or similarly broad metadata tags.
- GrowthX/imported-learning tags are retrieval labels, not lessons. If they reveal useful guidance, extract the actual guidance from the event bodies and preserve provenance.
- Before accepting any promotion, check whether an equivalent lesson/fact/summary already exists. Prefer stable IDs, update, merge, or report a duplicate instead of creating timestamped near-duplicates.
- Archive generated lessons whose body is only a count, a tag name, or a source-list. These are indexes, not memories.
- Treat clusters of tool errors, runner failures, agent activity, or Slack message counts as health/telemetry findings, not associative-memory lessons.
- If the deterministic/native pass promotes low-value tag summaries caused by bad input labels, explicitly call them out in the final report and recommend cleanup rather than validating them as good memories.

Do not run this on every Slack message. This is an offline/operator-triggered pass, not the hot capture path.
