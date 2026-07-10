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

Run Junior's offline v3 memory consolidation sweep (docs/features/memory-system-v3.md §7)
and report exactly what it wrote.

The executor normally runs this sweep natively (in-process, no agent) and ignores
this prompt. If you are an agent reading this, the native path did not run — you
must execute the sweep yourself:

1. Resolve the Junior project root from the runtime context (`junior.projectRoot`;
   `junior.memoryCli` is the CLI entry point).
2. From the project root, run the full sweep:

   ```
   bun run src/memory/cli.ts consolidate-v3
   ```

   Do not pass `--thread` or `--limit` — the scheduled sweep must cover the entire
   unconsolidated backlog. Leave batching flags (`--max-batch-chars`, `--body-cap`,
   `--kinds`) at their defaults unless the operator asked otherwise.
3. The command drains unconsolidated `memory_source_record`s (high-value kinds
   only: `slack_message`, `curated_fact`, `manual_correction`), groups them by
   thread, bin-packs the groups into batches, and spawns the consolidation runner
   (`claude -p`, structured output) per batch to derive:
   - **episodes** — what happened, with provenance back to the source records;
   - **entity profiles** — keyed markdown for a person / repo / situation, merged
     (never duplicated) on `entity_ref`;
   - **claims** — atomic lessons / facts, embedded locally and proximity-deduped
     against the existing corpus before write.
4. Interpret the output: per-batch failures (malformed runner JSON, timeout) are
   reported inline and those records stay unconsolidated to retry next run — list
   them, but only treat the workflow as failed if the CLI itself exits non-zero.
5. Return the sweep summary as the workflow result: records processed, episodes,
   profiles, and claims written/deduped per scope, plus any per-batch failures.

Rules:

- Run the sweep exactly once. Do not re-run it to "fix" a batch failure — failed
  batches retry automatically on the next scheduled run.
- Do not edit memory database rows directly; the runner's structured output
  persisted through the write gates is the only write path. Raw source records
  remain authoritative and derived memory is always rebuildable from them.
- This is an offline / operator-triggered pass (daily cron + the
  `memory-consolidation` command), never the hot capture path. Do not wire it to
  run on every Slack message.
