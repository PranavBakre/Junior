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
import { cappedBodyLength } from "./prompt.ts";
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
 * Default batch size budget (chars). NOTE: this counts EVIDENCE body chars only
 * (the body-capped `cappedBodyLength` sum) — it excludes the per-record framing
 * (`- id=… from=… kind=… thread=…`) and the `…[truncated]` marker, so it is NOT
 * an exact bound on the bytes actually sent. That is safe only because ~48k chars
 * (≈ ~12k tokens of evidence) sits far under every runner's context window, leaving
 * ample room for the framing, the prompt scaffold, the profile/claim context block,
 * and the JSON output.
 */
export const DEFAULT_MAX_BATCH_CHARS = 48_000;

/**
 * Default per-record body cap (chars). runner_output records are long and rarely
 * need full text for memory derivation; capping bounds both the prompt size and
 * a single oversized thread (so it stays its own bounded batch).
 */
export const DEFAULT_BODY_CAP = 2_000;

/**
 * Default set of source-record kinds the sweep consolidates when `kinds` is
 * unset: the high-value evidence. The live backlog is dominated by low-value
 * `runner_output` transcript noise (plus `routing_decision` telemetry), so those
 * are excluded by default — they stay unconsolidated (deferred), not processed.
 */
export const DEFAULT_CONSOLIDATION_KINDS: readonly string[] = [
  "slack_message",
  "curated_fact",
  "manual_correction",
];

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
  /**
   * Source-record kinds to consolidate (full-sweep mode). Records of other kinds
   * are left unconsolidated (deferred, never marked). Defaults to
   * DEFAULT_CONSOLIDATION_KINDS (the high-value set).
   */
  kinds?: string[];
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
 * records once, FILTER to the allowed `kinds` (default = the high-value set), then
 * group by thread (unthreaded → one `(unthreaded)` group) and size each group by
 * its body-capped char total. A group whose size exceeds `maxBatchChars` is SPLIT
 * into consecutive sub-chunks (each ≤ budget; a lone record over budget is its own
 * chunk), each its own batch. The remaining ≤budget groups are First-Fit-Decreasing
 * bin-packed into batches whose capped size ≤ `maxBatchChars`. Each thread's records
 * stay contiguous within a batch (and in source order across its split chunks).
 *
 * Incrementality is automatic: only unconsolidated records are fetched, so
 * fully-consolidated threads never appear, and each batch stamps exactly the
 * records it processed (records of excluded kinds are simply never touched).
 * `limit` applies only to single-thread (`threadId`) mode.
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

  // Full sweep: fetch every pending record once, filter to allowed kinds, group
  // by thread, split oversized groups, then bin-pack the rest.
  const allowedKinds = new Set(args.kinds ?? DEFAULT_CONSOLIDATION_KINDS);
  const pending = (await store.listUnconsolidatedSourceRecords({})).filter((r) =>
    allowedKinds.has(r.kind),
  );
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
  // actually sent (capped kinds count at min(len, bodyCap), high-value kinds in full).
  const sized = [...groups.entries()].map(([threadId, records]) => ({
    threadId,
    records,
    size: records.reduce((sum, r) => sum + cappedBodyLength(r, bodyCap), 0),
  }));

  // Oversized groups are split into ≤budget sub-chunks (each its own batch); the
  // rest are FFD-packed. Process oversized splits first for a deterministic order.
  const batches: Array<{ threadIds: string[]; records: MemorySourceRecord[] }> = [];
  const packable: typeof sized = [];
  for (const group of sized) {
    if (group.size > maxBatchChars) {
      for (const chunk of splitGroup(group.records, maxBatchChars, bodyCap)) {
        batches.push({ threadIds: [group.threadId], records: chunk });
      }
    } else {
      packable.push(group);
    }
  }

  // First-Fit-Decreasing: place the largest groups first into the first batch
  // that still has room (all packable groups are ≤ budget by construction).
  packable.sort((a, b) => b.size - a.size);
  const bins: Array<{ threadIds: string[]; records: MemorySourceRecord[]; size: number }> = [];
  for (const group of packable) {
    let target = bins.find((b) => b.size + group.size <= maxBatchChars);
    if (!target) {
      target = { threadIds: [], records: [], size: 0 };
      bins.push(target);
    }
    target.threadIds.push(group.threadId);
    target.records.push(...group.records);
    target.size += group.size;
  }
  for (const bin of bins) batches.push({ threadIds: bin.threadIds, records: bin.records });

  for (const batch of batches) {
    await runBatch(batch.threadIds, { records: batch.records });
  }
  return reports;
}

/**
 * Split one thread-group's records into consecutive sub-chunks whose body-capped
 * size is ≤ `maxBatchChars`. Greedy: accumulate records until the next would
 * overflow, then start a new chunk. A single record larger than the budget cannot
 * be split further, so it becomes its own (over-budget) chunk. Records stay in
 * source order, so the thread reads contiguously across its chunks.
 */
function splitGroup(
  records: MemorySourceRecord[],
  maxBatchChars: number,
  bodyCap: number,
): MemorySourceRecord[][] {
  const chunks: MemorySourceRecord[][] = [];
  let current: MemorySourceRecord[] = [];
  let currentSize = 0;
  for (const r of records) {
    const size = cappedBodyLength(r, bodyCap);
    if (current.length > 0 && currentSize + size > maxBatchChars) {
      chunks.push(current);
      current = [];
      currentSize = 0;
    }
    current.push(r);
    currentSize += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
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
