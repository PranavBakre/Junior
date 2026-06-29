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
import { consolidateSession } from "./consolidate.ts";
import type { ConsolidationInvoke, ConsolidationReport } from "./types.ts";

/** One entry per consolidated scope: either a report or a captured failure. */
export type ConsolidateV3Entry = {
  threadId: string | null;
  report?: ConsolidationReport;
  error?: string;
};

export interface RunConsolidationSweepArgs {
  store: MemoryStore;
  profileStore: ProfileStore;
  embedder: EmbeddingProvider;
  invoke: ConsolidationInvoke;
  /** Scope the whole sweep to a single thread. `limit` applies only in this mode. */
  threadId?: string;
  /** Cap the records pulled in the single-thread pass (ignored in full-sweep mode). */
  limit?: number;
  /** Clock (epoch ms) forwarded to the engine. Defaults to Date.now() per call. */
  now?: number;
}

/**
 * Run the offline consolidation sweep and return one entry per scope.
 *
 * Each session is isolated: a failed consolidation (malformed LLM JSON, timeout,
 * non-zero claude exit) is recorded and the sweep continues to the next thread
 * rather than aborting. The failed thread's records stay unconsolidated and retry
 * on the next run.
 *
 * Consolidation is session-scoped: we derive per distinct thread on its own
 * evidence rather than mixing threads into one prompt, then a final unscoped sweep
 * mops up records that carry no thread id. Threads are discovered WITHOUT a limit
 * and drained fully, so the unscoped sweep only ever sees unthreaded records —
 * threading `limit` into the per-thread or discovery path would leak a thread's
 * overflow into the unscoped sweep and mix sessions. `limit` therefore applies
 * only to single-thread (`threadId`) mode.
 */
export async function runConsolidationSweep(
  args: RunConsolidationSweepArgs,
): Promise<ConsolidateV3Entry[]> {
  const { store, profileStore, embedder, invoke } = args;
  const reports: ConsolidateV3Entry[] = [];

  const runOne = async (threadId: string | undefined, passLimit?: number) => {
    try {
      const report = await consolidateSession({
        store,
        profileStore,
        embedder,
        invoke,
        threadId,
        limit: passLimit,
        now: args.now,
      });
      reports.push({ threadId: threadId ?? null, report });
    } catch (err) {
      reports.push({ threadId: threadId ?? null, error: err instanceof Error ? err.message : String(err) });
    }
  };

  if (args.threadId) {
    await runOne(args.threadId, args.limit);
    return reports;
  }

  const pending = await store.listUnconsolidatedSourceRecords({});
  const threadIds = [...new Set(pending.map((r) => r.threadId).filter((t): t is string => Boolean(t)))];
  for (const threadId of threadIds) await runOne(threadId, undefined);
  const hasUnthreaded = pending.some((r) => !r.threadId);
  if (hasUnthreaded || reports.length === 0) await runOne(undefined, undefined);
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

  for (const { threadId, report, error } of reports) {
    const scope = threadId ?? "(all unthreaded)";
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
