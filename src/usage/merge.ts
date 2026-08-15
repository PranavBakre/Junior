import {
  sumPresent,
  type NormalizedUsage,
  type UsageEvent,
} from "./normalize.ts";

export function mergeUsage(
  existing: UsageEvent,
  incoming: NormalizedUsage,
): UsageEvent {
  const inputTokens = sumNullable(existing.inputTokens, incoming.inputTokens);
  const outputTokens = sumNullable(existing.outputTokens, incoming.outputTokens);
  const cacheReadTokens = sumNullable(
    existing.cacheReadTokens,
    incoming.cacheReadTokens,
  );
  const cacheWriteTokens = sumNullable(
    existing.cacheWriteTokens,
    incoming.cacheWriteTokens,
  );
  return {
    id: existing.id,
    sourceKind: existing.sourceKind,
    sourceId: existing.sourceId,
    threadId: existing.threadId ?? incoming.threadId,
    channelId: existing.channelId ?? incoming.channelId,
    agentName: existing.agentName ?? incoming.agentName,
    provider: existing.provider ?? incoming.provider,
    providerSessionId: existing.providerSessionId ?? incoming.providerSessionId,
    pipelineRunId: existing.pipelineRunId ?? incoming.pipelineRunId,
    assignmentId: existing.assignmentId ?? incoming.assignmentId,
    workflowName: existing.workflowName ?? incoming.workflowName,
    workflowRunId: existing.workflowRunId ?? incoming.workflowRunId,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: sumPresent([
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
    ]),
    costUsd: sumNullable(existing.costUsd, incoming.costUsd),
    costEstimatedUsd: null,
    numTurns: maxNullable(existing.numTurns, incoming.numTurns),
    raw: mergeRaw(existing.raw, incoming.raw),
    occurredAt: Math.min(existing.occurredAt, incoming.occurredAt),
  };
}

export function mergeNormalizedUsage(
  existing: NormalizedUsage,
  incoming: NormalizedUsage,
): NormalizedUsage {
  const { id: _id, ...merged } = mergeUsage(
    { id: "merge", ...existing },
    incoming,
  );
  return merged;
}

function sumNullable(a: number | null, b: number | null): number | null {
  if (a == null && b == null) return null;
  return (a ?? 0) + (b ?? 0);
}

function maxNullable(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
}

function mergeRaw(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const existingEmpty = Object.keys(existing).length === 0;
  const incomingEmpty = Object.keys(incoming).length === 0;
  if (existingEmpty) return incomingEmpty ? {} : incoming;
  if (incomingEmpty) return existing;
  const parts = [
    ...rawParts(existing),
    ...rawParts(incoming),
  ];
  return { parts };
}

function rawParts(raw: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(raw.parts)) {
    return raw.parts.filter(
      (part): part is Record<string, unknown> =>
        part !== null && typeof part === "object" && !Array.isArray(part),
    );
  }
  return [raw];
}
