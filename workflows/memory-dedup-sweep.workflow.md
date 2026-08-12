---
name: memory-dedup-sweep
enabled: true
description: Report claim near-duplicates that predate the write guard — cluster them, name the survivor, and archive nothing until an operator applies it.
nativeHandler: memory-dedup-sweep
ownerSlackUserIds: []
triggers:
  - type: schedule
    cron: "12 7 * * 1"
    timezone: Asia/Kolkata
  - type: command
    command: memory-dedup-sweep
outputs:
  - type: docs
    path: data/workflow-runs/memory-dedup-sweep
permissions:
  tools:
    - docs.write
    - memory.read
    - memory.evaluate
concurrency: skip
---

Report the claim near-duplicates already sitting in Junior's v3 memory
(docs/features/claim-dedup-write-guard.md §Backfill).

The executor runs this sweep natively (in-process, no agent) and ignores this
prompt. The clustering is deterministic cosine work — an agent pass on top would
only paraphrase a report it cannot improve. If you are an agent reading this, the
native path did not run and you must produce the report yourself:

1. Resolve the Junior project root from the runtime context (`junior.projectRoot`;
   `junior.memoryCli` is the CLI entry point).
2. From the project root, run the sweep in its default DRY-RUN mode:

   ```
   bun run src/memory/cli.ts dedup-sweep --json
   ```

3. Return the report as the workflow result: claims scanned, clusters found,
   duplicates found, and the per-cluster survivor with the claims it would absorb.

Rules:

- **This workflow never mutates memory.** The sweep is dry-run by default, the
  same posture as `migrate-v3.ts`. A merged-away claim is recoverable only from
  provenance, so an operator reviews the plan before it is committed.
- Committing is an explicit operator action, not a scheduled one:
  `bun run src/memory/cli.ts dedup-sweep --apply`. Stop the bot first — it holds
  a WAL writer on `data/memory.db`.
- Applying ARCHIVES duplicates (`active = 0`) and never deletes them, matching
  the claim decay contract. The collapsed rows stay as provenance for the merge.
- Only claims that share a dedup scope (same `kind`, same `repo`) are clustered.
  A cross-scope near-duplicate is reported by `memoryHealth`, never merged.
- Do not hand-edit memory database rows to "fix" a cluster. The sweep and the
  store's write guard are the only claim-collapse paths.
