export type UsageSourceKind =
  | "session-turn"
  | "workflow-run"
  | "pipeline-assignment";

export type NormalizedUsage = {
  sourceKind: UsageSourceKind;
  sourceId: string;
  threadId: string | null;
  channelId: string | null;
  agentName: string | null;
  provider: string | null;
  providerSessionId: string | null;
  pipelineRunId: string | null;
  assignmentId: string | null;
  workflowName: string | null;
  workflowRunId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  costEstimatedUsd: null;
  numTurns: number | null;
  raw: Record<string, unknown>;
  occurredAt: number;
};

export type UsageEvent = NormalizedUsage & { id: string };

export type UsageMeta = Omit<
  NormalizedUsage,
  | "inputTokens"
  | "outputTokens"
  | "cacheReadTokens"
  | "cacheWriteTokens"
  | "totalTokens"
  | "costUsd"
  | "costEstimatedUsd"
  | "numTurns"
  | "raw"
>;

export function normalizeRunnerUsage(
  usage: Record<string, unknown> | undefined,
  meta: UsageMeta,
): NormalizedUsage {
  if (!usage) {
    return emptyUsage(meta, {});
  }

  const raw = { ...usage };
  const provider = meta.provider;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let cacheReadTokens: number | null = null;
  let cacheWriteTokens: number | null = null;
  let costUsd: number | null = null;
  let numTurns: number | null = null;

  if (provider === "claude") {
    const nested = asRecord(usage.usage) ?? usage;
    inputTokens = readNumber(nested.input_tokens);
    outputTokens = readNumber(nested.output_tokens);
    cacheReadTokens = readNumber(nested.cache_read_input_tokens);
    cacheWriteTokens = readNumber(nested.cache_creation_input_tokens);
    costUsd = readNumber(usage.total_cost_usd);
    numTurns = readNumber(usage.num_turns);
  } else if (provider === "codex-app-server" || provider === "codex") {
    inputTokens = readNumber(usage.input_tokens);
    outputTokens = readNumber(usage.output_tokens);
    cacheReadTokens = readNumber(usage.cache_read_input_tokens);
    cacheWriteTokens = readNumber(usage.cache_creation_input_tokens);
  } else {
    const tokens = asRecord(usage.tokens) ?? usage;
    inputTokens = readNumber(tokens.input) ?? readNumber(tokens.input_tokens);
    outputTokens = readNumber(tokens.output) ?? readNumber(tokens.output_tokens);
  }

  return {
    ...meta,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens:
      readNumber(usage.total_tokens) ??
      sumPresent([
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
      ]),
    costUsd,
    costEstimatedUsd: null,
    numTurns,
    raw,
  };
}

function emptyUsage(
  meta: UsageMeta,
  raw: Record<string, unknown>,
): NormalizedUsage {
  return {
    ...meta,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    totalTokens: null,
    costUsd: null,
    costEstimatedUsd: null,
    numTurns: null,
    raw,
  };
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function sumPresent(values: Array<number | null>): number | null {
  let total = 0;
  let seen = false;
  for (const value of values) {
    if (value == null) continue;
    total += value;
    seen = true;
  }
  return seen ? total : null;
}
