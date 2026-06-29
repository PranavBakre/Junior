// Consolidation sweep — the shared orchestration loop around `consolidateSession`
// (memory v3 §7). The engine itself (`consolidate.ts`) consolidates ONE scope per
// call; this helper drives the full offline sweep so the CLI (`consolidate-v3`),
// the memory-consolidation workflow, and the `memory_consolidate` MCP tool all run
// the SAME loop instead of duplicating the per-thread + unthreaded-sweep + isolation
// logic. It never spawns anything itself — the LLM (`invoke`) and embedder are
// injected, so callers/tests fully control the boundaries.

import type { EmbeddingProvider } from "../embedding/types.ts";
import type { ProfileStore } from "../profiles/store.ts";
import type { MemoryStore } from "../store.ts";
import type { MemorySourceRecord } from "../types.ts";
import { consolidateSession } from "./consolidate.ts";
import type { ConsolidationInvoke, ConsolidationReport } from "./types.ts";

/**
 * One entry per consolidated BATCH: either a report or a captured failure. A
 * batch may club several threads into one `claude -p` call, so it lists every
 * thread id it covered (the unthreaded group surfaces as `(unthreaded)`).
 */
export type ConsolidateV3Entry = {
  threadIds: string[];
  report?: ConsolidationReport;
  error?: string;
};

/**
 * Default batch size budget (chars), measured on the BODY-CAPPED evidence that
 * is actually sent. Conservative: ~48k chars ≈ ~12k tokens of evidence, leaving
 * ample room for the prompt scaffold, the profile/claim context block, and the
 * JSON output within the model context window.
 */
export const DEFAULT_MAX_BATCH_CHARS = 48_000;

/**
 * Default per-record body cap (chars). runner_output records are long and rarely
 * need full text for memory derivation; capping bounds both the prompt size and
 * a single oversized thread (so it stays its own bounded batch).
 */
export const DEFAULT_BODY_CAP = 2_000;

/** Label for the group of records that carry no thread id. */
const UNTHREADED_GROUP = "(unthreaded)";

export interface RunConsolidationSweepArgs {
  store: MemoryStore;
  profileStore: ProfileStore;
  embedder: EmbeddingProvider;
  invoke: ConsolidationInvoke;
  /** Scope the whole sweep to a single thread. `limit` applies only in this mode. */
  threadId?: string;
  /** Cap the records pulled in the single-thread pass (ignored in full-sweep mode). */
  limit?: number;
  /** Max body-capped char total per batch (full-sweep mode). Defaults to DEFAULT_MAX_BATCH_CHARS. */
  maxBatchChars?: number;
  /** Per-record body cap (chars) forwarded to the prompt. Defaults to DEFAULT_BODY_CAP. */
  bodyCap?: number;
  /** Clock (epoch ms) forwarded to the engine. Defaults to Date.now() per call. */
  now?: number;
}

/**
 * Run the offline consolidation sweep and return one entry per BATCH.
 *
 * Each batch is isolated: a failed consolidation (malformed LLM JSON, timeout,
 * non-zero claude exit) is recorded and the sweep continues to the next batch
 * rather than aborting. The failed batch's records stay unconsolidated and retry
 * on the next run.
 *
 * Batching policy: earlier versions derived ONE thread per `claude -p` call to
 * avoid cross-thread conflation. We now deliberately club several threads into
 * fewer, fuller calls — provenance is keyed on source-record ids (episodes cite
 * their `sourceRecordId`; only records in the set are promoted), so a record set
 * spanning threads still persists correctly, and the prompt scaffold tells the
 * model to judge each `thread=` group on its own. We fetch all unconsolidated
 * records once, group by thread (unthreaded → one `(unthreaded)` group), size
 * each group by its body-capped char total, and First-Fit-Decreasing bin-pack
 * groups into batches whose capped size ≤ `maxBatchChars`. A single group larger
 * than `maxBatchChars` becomes its own batch (its bodies are capped, so it stays
 * bounded). Each thread's records stay contiguous within a batch.
 *
 * Incrementality is automatic: only unconsolidated records are fetched, so
 * fully-consolidated threads never appear, and each batch stamps exactly the
 * records it processed. `limit` applies only to single-thread (`threadId`) mode.
 */
export async function runConsolidationSweep(
  args: RunConsolidationSweepArgs,
): Promise<ConsolidateV3Entry[]> {
  const { store, profileStore, embedder, invoke } = args;
  const maxBatchChars = args.maxBatchChars ?? DEFAULT_MAX_BATCH_CHARS;
  const bodyCap = args.bodyCap ?? DEFAULT_BODY_CAP;
  const reports: ConsolidateV3Entry[] = [];

  const runBatch = async (
    threadIds: string[],
    sessionArgs: { records?: MemorySourceRecord[]; threadId?: string; limit?: number },
  ) => {
    try {
      const report = await consolidateSession({
        store,
        profileStore,
        embedder,
        invoke,
        bodyCap,
        now: args.now,
        ...sessionArgs,
      });
      reports.push({ threadIds, report });
    } catch (err) {
      reports.push({ threadIds, error: err instanceof Error ? err.message : String(err) });
    }
  };

  // Single-thread mode: unchanged scope, honoring `limit`.
  if (args.threadId) {
    await runBatch([args.threadId], { threadId: args.threadId, limit: args.limit });
    return reports;
  }

  // Full sweep: fetch every pending record once, group by thread, bin-pack.
  const pending = await store.listUnconsolidatedSourceRecords({});
  if (pending.length === 0) return [{ threadIds: [], report: { skipped: true } }];

  // Group by thread, preserving first-seen (oldest-first) order so each thread's
  // records stay contiguous.
  const groups = new Map<string, MemorySourceRecord[]>();
  for (const r of pending) {
    const key = r.threadId ?? UNTHREADED_GROUP;
    const group = groups.get(key);
    if (group) group.push(r);
    else groups.set(key, [r]);
  }

  // Size each group by the BODY-CAPPED char total — the sizing must match what is
  // actually sent (a thread of huge bodies packs by its capped size, not raw).
  const sized = [...groups.entries()].map(([threadId, records]) => ({
    threadId,
    records,
    size: records.reduce((sum, r) => sum + Math.min(r.body.length, bodyCap), 0),
  }));

  // First-Fit-Decreasing: place the largest groups first into the first batch
  // that still has room; an over-budget group lands alone in a fresh batch.
  sized.sort((a, b) => b.size - a.size);
  const batches: Array<{ threadIds: string[]; records: MemorySourceRecord[]; size: number }> = [];
  for (const group of sized) {
    let target = batches.find((b) => b.size + group.size <= maxBatchChars);
    if (!target) {
      target = { threadIds: [], records: [], size: 0 };
      batches.push(target);
    }
    target.threadIds.push(group.threadId);
    target.records.push(...group.records);
    target.size += group.size;
  }

  for (const batch of batches) {
    await runBatch(batch.threadIds, { records: batch.records });
  }
  return reports;
}

/**
 * Human-readable summary of a sweep (for the workflow artifact / Slack output and
 * any non-JSON CLI surface that wants per-scope totals).
 */
export function summarizeConsolidationSweep(reports: ConsolidateV3Entry[]): string {
  if (reports.length === 0) return "Memory consolidation (v3): no unconsolidated source records.";

  const lines = ["Memory consolidation (v3) complete."];
  let records = 0;
  let episodes = 0;
  let profiles = 0;
  let claims = 0;
  let deduped = 0;
  let failures = 0;

  for (const { threadIds, report, error } of reports) {
    const scope = threadIds.length ? threadIds.join(", ") : "(all unthreaded)";
    if (error) {
      lines.push(`- ${scope}: FAILED — ${error}`);
      failures += 1;
      continue;
    }
    if (!report || report.skipped) {
      lines.push(`- ${scope}: skipped (nothing to consolidate)`);
      continue;
    }
    records += report.recordsProcessed;
    episodes += report.episodes;
    profiles += report.profiles;
    claims += report.claimsWritten;
    deduped += report.claimsDeduped;
    lines.push(
      `- ${scope}: ${report.recordsProcessed} records → ${report.episodes} episodes, ` +
        `${report.profiles} profiles, ${report.claimsWritten} claims (${report.claimsDeduped} deduped)`,
    );
  }

  lines.push(
    `Totals: ${records} records processed, ${episodes} episodes, ${profiles} profiles, ` +
      `${claims} claims written (${deduped} deduped)${failures ? `, ${failures} failed scope(s)` : ""}.`,
  );
  return lines.join("\n");
}
