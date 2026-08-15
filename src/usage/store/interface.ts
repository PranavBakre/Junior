import type {
  NormalizedUsage,
  UsageEvent,
  UsageSourceKind,
} from "../normalize.ts";

export type { NormalizedUsage, UsageEvent, UsageSourceKind };

export type UsageGroupBy =
  | "day"
  | "session"
  | "agent"
  | "provider"
  | "workflow"
  | "pipeline";

export type UsageTotals = {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  costEstimatedUsd: number;
  missingUsageTurns: number;
};

export type UsageBucket = {
  key: string;
  label: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  costEstimatedUsd: number;
};

export type UsageGroupResult = {
  totals: UsageTotals;
  buckets: UsageBucket[];
};

export interface UsageStore {
  add(usage: NormalizedUsage): Promise<UsageEvent>;
  get(
    sourceKind: UsageSourceKind,
    sourceId: string,
  ): Promise<UsageEvent | undefined>;
  list(filter?: {
    from?: number;
    to?: number;
    threadId?: string;
    sourceKind?: UsageSourceKind;
    limit?: number;
  }): Promise<UsageEvent[]>;
  groupBy(input: {
    from: number;
    to: number;
    groupBy: UsageGroupBy;
  }): Promise<UsageGroupResult>;
  count(filter?: {
    from?: number;
    to?: number;
    threadId?: string;
    sourceKind?: UsageSourceKind;
  }): Promise<number>;
  summarizeByThread(threadIds: string[]): Promise<UsageBucket[]>;
  deleteOlderThan(occurredAt: number): Promise<number>;
  close?(): void;
}
