import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteTaskRouteStore } from "./sqlite.ts";
import type { TaskRouteStepRecord, TaskRouteUpsert } from "../types.ts";

function step(ord: number, over: Partial<TaskRouteStepRecord> = {}): TaskRouteStepRecord {
  return {
    ord,
    note: `step ${ord}`,
    path: `src/file${ord}.ts`,
    symbol: `sym${ord}`,
    declPattern: `pattern${ord}`,
    sigHash: `sig${ord}`,
    blockHash: `block${ord}`,
    expectsRef: null,
    touchCount: 0,
    ...over,
  };
}

function route(over: Partial<TaskRouteUpsert> = {}): TaskRouteUpsert {
  return {
    id: "route_junior__memory-view__add-ui-surface",
    repo: "junior",
    feature: "memory-view",
    taskKind: "add-ui-surface",
    taskDesc: "add a filter to the dashboard memory view",
    embedding: new Float32Array([1, 0, 0, 0]),
    embedModel: "hashing",
    dim: 4,
    verifiedSha: "aaaa",
    createdAt: 1_000,
    steps: [step(1), step(2)],
    ...over,
  };
}

describe("SqliteTaskRouteStore", () => {
  let tmpDir: string;
  let store: SqliteTaskRouteStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "junior-routes-db-"));
    store = new SqliteTaskRouteStore(join(tmpDir, "memory.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates the unique identity index", () => {
    const db = (store as unknown as { db: Database }).db;
    const row = db
      .query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name='task_route_identity'",
      )
      .get();
    expect(row?.sql).toContain("(repo, feature, task_kind)");
  });

  it("stores a route with its steps in ord order", async () => {
    const stored = await store.upsertRoute(route());
    expect(stored.steps.map((s) => s.ord)).toEqual([1, 2]);
    expect(stored.steps[0].sigHash).toBe("sig1");
    expect(stored.active).toBe(true);
    expect(stored.fetchCount).toBe(0);
  });

  it("upserts on the (repo, feature, task_kind) identity instead of inserting a second row", async () => {
    const first = await store.upsertRoute(route());
    const second = await store.upsertRoute(
      route({
        // A different id for the same identity must NOT create a second route.
        id: "route_generated_differently",
        taskDesc: "rewritten description",
        verifiedSha: "bbbb",
        steps: [step(1, { note: "only step now" })],
      }),
    );

    expect(second.id).toBe(first.id);
    expect(second.taskDesc).toBe("rewritten description");
    expect(second.verifiedSha).toBe("bbbb");
    expect(second.steps).toHaveLength(1);
    expect(second.steps[0].note).toBe("only step now");

    const db = (store as unknown as { db: Database }).db;
    const count = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM task_route").get();
    expect(count?.n).toBe(1);
    const steps = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM task_route_step")
      .get();
    expect(steps?.n).toBe(1);
  });

  it("revives an archived row rather than inserting alongside it", async () => {
    const stored = await store.upsertRoute(route());
    await store.recordFetch(stored.id, { now: 2_000, repairs: [], brokenFetches: 3, active: false });
    expect((await store.getRoute(stored.id))?.active).toBe(false);

    const revived = await store.upsertRoute(route({ taskDesc: "second life" }));
    expect(revived.id).toBe(stored.id);
    expect(revived.active).toBe(true);
    expect(revived.brokenFetches).toBe(0);
    // fetch_count is history of the identity and survives the overwrite.
    expect(revived.fetchCount).toBe(1);
  });

  it("records a fetch: counters, repairs, and archival in one write", async () => {
    const stored = await store.upsertRoute(route());
    await store.recordFetch(stored.id, {
      now: 5_000,
      verifiedSha: "cccc",
      repairs: [
        {
          ord: 2,
          path: "src/moved.ts",
          declPattern: "new-pattern",
          sigHash: "new-sig",
          blockHash: "new-block",
        },
      ],
      brokenFetches: 0,
    });

    const after = await store.getRoute(stored.id);
    expect(after?.fetchCount).toBe(1);
    expect(after?.lastUsedAt).toBe(5_000);
    expect(after?.repairCount).toBe(1);
    expect(after?.verifiedSha).toBe("cccc");
    const repaired = after?.steps.find((s) => s.ord === 2);
    expect(repaired?.path).toBe("src/moved.ts");
    expect(repaired?.sigHash).toBe("new-sig");
    // Untouched steps are left exactly as they were.
    expect(after?.steps.find((s) => s.ord === 1)?.path).toBe("src/file1.ts");
  });

  it("bumps touch_count only for steps that exist", async () => {
    const stored = await store.upsertRoute(route());
    const updated = await store.recordUsage(stored.id, [1, 1, 7]);
    expect(updated).toBe(1);
    const after = await store.getRoute(stored.id);
    expect(after?.steps.find((s) => s.ord === 1)?.touchCount).toBe(1);
    expect(after?.steps.find((s) => s.ord === 2)?.touchCount).toBe(0);
  });

  it("recalls by cosine over task_desc, active routes only, scoped to repo", async () => {
    await store.upsertRoute(route());
    await store.upsertRoute(
      route({
        id: "route_other",
        feature: "other-feature",
        taskDesc: "unrelated",
        embedding: new Float32Array([0, 1, 0, 0]),
      }),
    );
    await store.upsertRoute(
      route({
        id: "route_elsewhere",
        repo: "gx-backend",
        embedding: new Float32Array([1, 0, 0, 0]),
      }),
    );

    const hits = await store.recallRoutes({
      queryVector: new Float32Array([1, 0, 0, 0]),
      repo: "junior",
      limit: 5,
    });
    expect(hits.map((h) => h.route.feature)).toEqual(["memory-view", "other-feature"]);
    expect(hits[0].cosine).toBeCloseTo(1, 5);
    expect(hits[1].cosine).toBeCloseTo(0, 5);

    // Archived routes drop out of search but stay reachable by exact identity.
    const archived = hits[0].route;
    await store.recordFetch(archived.id, { now: 9_000, repairs: [], brokenFetches: 3, active: false });
    const afterArchive = await store.recallRoutes({
      queryVector: new Float32Array([1, 0, 0, 0]),
      repo: "junior",
    });
    expect(afterArchive.map((h) => h.route.feature)).toEqual(["other-feature"]);
    expect(await store.getRouteByIdentity("junior", "memory-view", "add-ui-surface")).not.toBeNull();
  });

  it("shares the memory DB file without disturbing the memory schema", async () => {
    const dbPath = join(tmpDir, "shared.db");
    const { SqliteMemoryStore } = await import("../../memory/sqlite.ts");
    const memory = new SqliteMemoryStore(dbPath);
    await memory.upsertClaim({
      id: "claim_x",
      kind: "lesson",
      text: "a claim",
      createdAt: 1,
    });
    const routes = new SqliteTaskRouteStore(dbPath);
    try {
      await routes.upsertRoute(route());
      const recalled = await memory.recallClaims({ recordUsage: false });
      expect(recalled.map((c) => c.id)).toEqual(["claim_x"]);
      expect(await routes.getRouteByIdentity("junior", "memory-view", "add-ui-surface")).not.toBeNull();
    } finally {
      routes.close();
      memory.close();
    }
  });
});
