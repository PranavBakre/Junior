import { mergeUsage } from "../merge.ts";
import type { NormalizedUsage, UsageEvent, UsageSourceKind } from "../normalize.ts";
import { groupUsageEvents, summarizeEventsByThread } from "./aggregate.ts";
import type { UsageBucket, UsageGroupBy, UsageGroupResult, UsageStore } from "./interface.ts";

export class InMemoryUsageStore implements UsageStore {
  private events = new Map<string, UsageEvent>();

  async add(usage: NormalizedUsage): Promise<UsageEvent> {
    const key = sourceKey(usage.sourceKind, usage.sourceId);
    const existing = this.events.get(key);
    const stored = existing
      ? mergeUsage(existing, usage)
      : { id: crypto.randomUUID(), ...usage };
    this.events.set(key, stored);
    return stored;
  }

  async get(
    sourceKind: UsageSourceKind,
    sourceId: string,
  ): Promise<UsageEvent | undefined> {
    return this.events.get(sourceKey(sourceKind, sourceId));
  }

  async list(filter: {
    from?: number;
    to?: number;
    threadId?: string;
    sourceKind?: UsageSourceKind;
    limit?: number;
  } = {}): Promise<UsageEvent[]> {
    const rows = [...this.events.values()]
      .filter((event) => matchesFilter(event, filter))
      .sort((a, b) => b.occurredAt - a.occurredAt || a.id.localeCompare(b.id));
    return filter.limit == null ? rows : rows.slice(0, filter.limit);
  }

  async groupBy(input: {
    from: number;
    to: number;
    groupBy: UsageGroupBy;
  }): Promise<UsageGroupResult> {
    const events = await this.list({ from: input.from, to: input.to });
    return groupUsageEvents(events, input.groupBy);
  }

  async count(filter: {
    from?: number;
    to?: number;
    threadId?: string;
    sourceKind?: UsageSourceKind;
  } = {}): Promise<number> {
    let total = 0;
    for (const event of this.events.values()) {
      if (matchesFilter(event, filter)) total += 1;
    }
    return total;
  }

  async summarizeByThread(threadIds: string[]): Promise<UsageBucket[]> {
    if (threadIds.length === 0) return [];
    const wanted = new Set(threadIds);
    const events = [...this.events.values()].filter(
      (event) => event.threadId != null && wanted.has(event.threadId),
    );
    return summarizeEventsByThread(events, threadIds);
  }

  async deleteOlderThan(occurredAt: number): Promise<number> {
    let deleted = 0;
    for (const [key, event] of this.events) {
      if (event.occurredAt < occurredAt) {
        this.events.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }
}

function sourceKey(sourceKind: UsageSourceKind, sourceId: string): string {
  return `${sourceKind}\0${sourceId}`;
}

function matchesFilter(
  event: UsageEvent,
  filter: {
    from?: number;
    to?: number;
    threadId?: string;
    sourceKind?: UsageSourceKind;
  },
): boolean {
  if (filter.from != null && event.occurredAt < filter.from) return false;
  if (filter.to != null && event.occurredAt > filter.to) return false;
  if (filter.threadId != null && event.threadId !== filter.threadId) return false;
  if (filter.sourceKind != null && event.sourceKind !== filter.sourceKind) {
    return false;
  }
  return true;
}
