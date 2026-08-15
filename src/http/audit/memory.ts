import type {
  DashboardAuditEntry,
  DashboardAuditRecordInput,
  DashboardAuditStore,
} from "./interface.ts";

export class InMemoryDashboardAuditStore implements DashboardAuditStore {
  private entries: DashboardAuditEntry[] = [];

  async record(entry: DashboardAuditRecordInput): Promise<DashboardAuditEntry> {
    const stored = toEntry(entry);
    this.entries.push(stored);
    return stored;
  }

  async list(filter: {
    action?: string;
    targetType?: string;
    from?: number;
    to?: number;
    limit?: number;
  } = {}): Promise<DashboardAuditEntry[]> {
    const rows = this.entries
      .filter((entry) => matchesFilter(entry, filter))
      .sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
    const limit = Math.min(filter.limit ?? 100, 500);
    return rows.slice(0, limit);
  }

  async count(filter: {
    action?: string;
    targetType?: string;
    from?: number;
    to?: number;
  } = {}): Promise<number> {
    return this.entries.filter((entry) => matchesFilter(entry, filter)).length;
  }

  async deleteOlderThan(at: number): Promise<number> {
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => entry.at >= at);
    return before - this.entries.length;
  }
}

function toEntry(entry: DashboardAuditRecordInput): DashboardAuditEntry {
  return {
    id: entry.id ?? crypto.randomUUID(),
    at: entry.at ?? Date.now(),
    actor: entry.actor,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    request: entry.request ?? {},
    result: entry.result,
    error: entry.error ?? null,
    slackTs: entry.slackTs ?? null,
    commitSha: entry.commitSha ?? null,
  };
}

function matchesFilter(
  entry: DashboardAuditEntry,
  filter: {
    action?: string;
    targetType?: string;
    from?: number;
    to?: number;
  },
): boolean {
  if (filter.action != null && entry.action !== filter.action) return false;
  if (filter.targetType != null && entry.targetType !== filter.targetType) {
    return false;
  }
  if (filter.from != null && entry.at < filter.from) return false;
  if (filter.to != null && entry.at > filter.to) return false;
  return true;
}
