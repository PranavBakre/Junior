/**
 * Retention GC for terminal pipeline runs.
 *
 * After PIPELINE_RETENTION_DAYS (default 90), prune delivered/dead outbox
 * payloads and compact verbose event payloads. NEVER touches active or
 * non-terminal runs.
 */

import type { Clock } from "../time/clock.ts";
import { systemClock } from "../time/clock.ts";
import { log } from "../logger.ts";
import type { PipelineStore } from "./store/interface.ts";

export const DEFAULT_PIPELINE_RETENTION_DAYS = 90;
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type GcOptions = {
  store: PipelineStore;
  /** Retention window in days. Default 90. */
  retentionDays?: number;
  clock?: Clock;
};

export type GcReport = {
  examined: number;
  runsCompacted: number;
  outboxCompacted: number;
  eventsCompacted: number;
  skippedActive: number;
};

/**
 * Compact history for terminal runs whose updatedAt is older than the
 * retention window. Active/waiting/needs-human runs are never selected.
 */
export async function gcTerminalPipelineHistory(
  options: GcOptions,
): Promise<GcReport> {
  const clock = options.clock ?? systemClock;
  const retentionDays =
    options.retentionDays ?? DEFAULT_PIPELINE_RETENTION_DAYS;
  const cutoff = clock.now() - retentionDays * MS_PER_DAY;

  const terminal = await options.store.listTerminalRuns({
    updatedBefore: cutoff,
  });

  const report: GcReport = {
    examined: terminal.length,
    runsCompacted: 0,
    outboxCompacted: 0,
    eventsCompacted: 0,
    skippedActive: 0,
  };

  for (const run of terminal) {
    // Defense in depth: never compact non-terminal even if a store mis-filters.
    if (run.status !== "terminal") {
      report.skippedActive += 1;
      continue;
    }
    const result = await options.store.compactTerminalRunHistory(run.id);
    if (result.outboxCompacted > 0 || result.eventsCompacted > 0) {
      report.runsCompacted += 1;
      report.outboxCompacted += result.outboxCompacted;
      report.eventsCompacted += result.eventsCompacted;
    }
  }

  if (report.runsCompacted > 0) {
    log.info(
      "pipeline-gc",
      `compacted ${report.runsCompacted} terminal run(s) ` +
        `(outbox=${report.outboxCompacted} events=${report.eventsCompacted}) ` +
        `retentionDays=${retentionDays}`,
    );
  }

  return report;
}
