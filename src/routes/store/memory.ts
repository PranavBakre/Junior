import type { TaskRouteStore } from "./interface.ts";
import type {
  RouteFetchBookkeeping,
  RouteRecallOptions,
  RouteRecallResult,
  TaskRouteRecord,
  TaskRouteUpsert,
} from "../types.ts";

/**
 * In-memory task-route store for tests and dev. Mirrors the SQLite semantics
 * that matter — one row per `(repo, feature, task_kind)`, revive-and-overwrite
 * on save, cosine recall over active routes only.
 */
export class InMemoryTaskRouteStore implements TaskRouteStore {
  private routes = new Map<string, TaskRouteRecord>();
  private vectors = new Map<string, Float32Array | null>();

  close(): void {
    this.routes.clear();
    this.vectors.clear();
  }

  async upsertRoute(route: TaskRouteUpsert): Promise<TaskRouteRecord> {
    const existing = this.findByIdentity(route.repo, route.feature, route.taskKind);
    const id = existing?.id ?? route.id;
    const record: TaskRouteRecord = {
      id,
      repo: route.repo,
      feature: route.feature,
      taskKind: route.taskKind,
      taskDesc: route.taskDesc,
      verifiedSha: route.verifiedSha,
      fetchCount: existing?.fetchCount ?? 0,
      repairCount: existing?.repairCount ?? 0,
      brokenFetches: 0,
      createdAt: existing?.createdAt ?? route.createdAt,
      lastUsedAt: existing?.lastUsedAt ?? null,
      active: route.active !== false,
      steps: route.steps.map((step) => ({ ...step })),
    };
    this.routes.set(id, record);
    this.vectors.set(id, route.embedding ?? null);
    return clone(record);
  }

  async getRoute(id: string): Promise<TaskRouteRecord | null> {
    const record = this.routes.get(id);
    return record ? clone(record) : null;
  }

  async getRouteByIdentity(
    repo: string,
    feature: string,
    taskKind: string,
  ): Promise<TaskRouteRecord | null> {
    const record = this.findByIdentity(repo, feature, taskKind);
    return record ? clone(record) : null;
  }

  async recallRoutes(options: RouteRecallOptions): Promise<RouteRecallResult[]> {
    const limit = options.limit ?? 5;
    const scored: RouteRecallResult[] = [];
    for (const record of this.routes.values()) {
      if (!record.active) continue;
      if (record.repo !== options.repo) continue;
      if (options.feature && record.feature !== options.feature) continue;
      const vector = this.vectors.get(record.id) ?? null;
      const cosine =
        options.queryVector && vector ? cosine32(options.queryVector, vector) : null;
      scored.push({ route: clone(record), cosine });
    }
    scored.sort((a, b) => (b.cosine ?? 0) - (a.cosine ?? 0));
    return scored.slice(0, limit);
  }

  async recordFetch(routeId: string, book: RouteFetchBookkeeping): Promise<void> {
    const record = this.routes.get(routeId);
    if (!record) return;
    record.fetchCount += 1;
    record.lastUsedAt = book.now;
    record.repairCount += book.repairs.length;
    record.brokenFetches = book.brokenFetches;
    if (book.verifiedSha) record.verifiedSha = book.verifiedSha;
    if (book.active !== undefined) record.active = book.active;
    for (const fix of book.repairs) {
      const step = record.steps.find((s) => s.ord === fix.ord);
      if (!step) continue;
      step.path = fix.path;
      step.declPattern = fix.declPattern;
      step.sigHash = fix.sigHash;
      step.blockHash = fix.blockHash;
    }
  }

  async recordUsage(routeId: string, ords: number[]): Promise<number> {
    const record = this.routes.get(routeId);
    if (!record) return 0;
    let updated = 0;
    for (const ord of new Set(ords)) {
      const step = record.steps.find((s) => s.ord === ord);
      if (!step) continue;
      step.touchCount += 1;
      updated += 1;
    }
    return updated;
  }

  private findByIdentity(
    repo: string,
    feature: string,
    taskKind: string,
  ): TaskRouteRecord | undefined {
    for (const record of this.routes.values()) {
      if (record.repo === repo && record.feature === feature && record.taskKind === taskKind) {
        return record;
      }
    }
    return undefined;
  }
}

function clone(record: TaskRouteRecord): TaskRouteRecord {
  return { ...record, steps: record.steps.map((step) => ({ ...step })) };
}

function cosine32(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
