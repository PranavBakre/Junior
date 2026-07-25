import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryTaskRouteStore } from "./memory.ts";
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

/**
 * The in-memory store is what every tool test runs against, so any invariant it
 * does not enforce is an invariant those tests cannot see. It previously had no
 * id constraint at all, which is exactly why a bug that made SQLite raise
 * `UNIQUE constraint failed: task_route.id` passed the whole suite.
 */
describe("InMemoryTaskRouteStore", () => {
  let store: InMemoryTaskRouteStore;

  beforeEach(() => {
    store = new InMemoryTaskRouteStore();
  });

  afterEach(() => {
    store.close();
  });

  it("upserts on the identity rather than inserting a second route", async () => {
    const first = await store.upsertRoute(route());
    const second = await store.upsertRoute(
      route({ id: "route_generated_differently", taskDesc: "rewritten", steps: [step(1)] }),
    );
    expect(second.id).toBe(first.id);
    expect(second.taskDesc).toBe("rewritten");
    expect(second.steps).toHaveLength(1);
    expect(await store.listRouteIdentities("junior")).toEqual([
      { feature: "memory-view", taskKind: "add-ui-surface", active: true },
    ]);
  });

  it("refuses to alias two identities onto one id, exactly as SQLite does", async () => {
    await store.upsertRoute(route());
    // The same id from a different identity is the shape that used to be
    // silently overwritten here and to throw a raw SQLite string in production.
    await expect(
      store.upsertRoute(route({ feature: "Memory View" })),
    ).rejects.toThrow(/UNIQUE constraint failed: task_route\.id/);
  });

  it("lists every identity for a repo, archived ones included", async () => {
    const stored = await store.upsertRoute(route());
    await store.upsertRoute(
      route({ id: "route_junior__other__debug", feature: "other", taskKind: "debug" }),
    );
    await store.upsertRoute(route({ id: "route_elsewhere", repo: "gx-backend" }));
    await store.recordFetch(stored.id, { now: 1, repairs: [], brokenFetches: 3, active: false });

    expect(await store.listRouteIdentities("junior")).toEqual([
      { feature: "memory-view", taskKind: "add-ui-surface", active: false },
      { feature: "other", taskKind: "debug", active: true },
    ]);
    expect(await store.listRouteIdentities("nothing-here")).toEqual([]);
  });

  it("pages identities identically to SQLite, cap and collation included", async () => {
    // The cap and the ordering live in the store, not the caller: applied above
    // them, the two implementations would hand back different subsets of the
    // same corpus past the cap. `Beta` sorts before `alpha` under SQLite's
    // BINARY collation and after it under `localeCompare` — the tools layer
    // lowercases identities before they ever get here, but the store contract
    // is what is being pinned.
    const identities = ["Beta", "alpha", "gamma"];
    const dir = mkdtempSync(join(tmpdir(), "junior-routes-parity-"));
    const sqlite = new SqliteTaskRouteStore(join(dir, "memory.db"));
    try {
      for (const feature of identities) {
        const input = route({ id: `route_junior__${feature}__k`, feature, taskKind: "k" });
        await store.upsertRoute(input);
        await sqlite.upsertRoute(input);
      }
      const fromMemory = await store.listRouteIdentities("junior", 2);
      expect(fromMemory.map((i) => i.feature)).toEqual(["Beta", "alpha"]);
      expect(await sqlite.listRouteIdentities("junior", 2)).toEqual(fromMemory);
    } finally {
      sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
