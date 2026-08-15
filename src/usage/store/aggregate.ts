import type { NormalizedUsage, UsageEvent } from "../normalize.ts";
import type {
  UsageBucket,
  UsageGroupBy,
  UsageGroupResult,
  UsageTotals,
} from "./interface.ts";

export function isMissingUsage(usage: NormalizedUsage): boolean {
  return (
    usage.inputTokens == null &&
    usage.outputTokens == null &&
    usage.cacheReadTokens == null &&
    usage.cacheWriteTokens == null &&
    usage.costUsd == null
  );
}

export function groupUsageEvents(
  events: UsageEvent[],
  groupBy: UsageGroupBy,
): UsageGroupResult {
  const buckets = new Map<string, UsageBucket>();
  const totals: UsageTotals = {
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    costEstimatedUsd: 0,
    missingUsageTurns: 0,
  };

  for (const event of events) {
    totals.turns += 1;
    totals.inputTokens += event.inputTokens ?? 0;
    totals.outputTokens += event.outputTokens ?? 0;
    totals.costUsd += event.costUsd ?? 0;
    if (isMissingUsage(event)) totals.missingUsageTurns += 1;

    const key = groupKey(event, groupBy);
    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, {
        key,
        label: key,
        turns: 1,
        inputTokens: event.inputTokens ?? 0,
        outputTokens: event.outputTokens ?? 0,
        costUsd: event.costUsd ?? 0,
        costEstimatedUsd: 0,
      });
      continue;
    }
    existing.turns += 1;
    existing.inputTokens += event.inputTokens ?? 0;
    existing.outputTokens += event.outputTokens ?? 0;
    existing.costUsd += event.costUsd ?? 0;
  }

  return {
    totals,
    buckets: [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key)),
  };
}

export function summarizeEventsByThread(
  events: UsageEvent[],
  threadIds: string[],
): UsageBucket[] {
  const wanted = new Set(threadIds);
  const buckets = new Map<string, UsageBucket>();
  for (const threadId of wanted) {
    buckets.set(threadId, {
      key: threadId,
      label: threadId,
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      costEstimatedUsd: 0,
    });
  }
  for (const event of events) {
    if (event.threadId == null) continue;
    const bucket = buckets.get(event.threadId);
    if (!bucket) continue;
    bucket.turns += 1;
    bucket.inputTokens += event.inputTokens ?? 0;
    bucket.outputTokens += event.outputTokens ?? 0;
    bucket.costUsd += event.costUsd ?? 0;
  }
  return [...buckets.values()];
}

function groupKey(event: UsageEvent, groupBy: UsageGroupBy): string {
  switch (groupBy) {
    case "day":
      return localDayKey(event.occurredAt);
    case "session":
      return event.threadId ?? "unknown";
    case "agent":
      return event.agentName ?? "unknown";
    case "provider":
      return event.provider ?? "unknown";
    case "workflow":
      return event.workflowName ?? event.workflowRunId ?? "unknown";
    case "pipeline":
      return event.pipelineRunId ?? "unknown";
  }
}

function localDayKey(occurredAt: number): string {
  const date = new Date(occurredAt);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
