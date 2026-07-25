import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "../../memory/sqlite.ts";
import { handleMemoryProjection, handleMemoryRecall } from "./memory.ts";

function withStore<T>(fn: (store: SqliteMemoryStore) => Promise<T>): Promise<T> {
  const tmpDir = mkdtempSync(join(tmpdir(), "junior-memory-http-"));
  const store = new SqliteMemoryStore(join(tmpDir, "memory.db"));
  return fn(store).finally(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });
}

async function seedClaim(
  store: SqliteMemoryStore,
  id: string,
  vector: number[],
  text = id,
): Promise<void> {
  await store.upsertClaim({
    id,
    kind: "fact",
    text,
    embedding: Float32Array.from(vector),
    dim: vector.length,
    tags: ["t-" + id],
    createdAt: Date.now(),
    // The projection tests seed deliberately TIGHT clusters (cosine ~0.99) to
    // check that neighbourhood structure survives the 3D projection. The store's
    // write guard would collapse them into one row, so seed past it.
    skipDedup: true,
  });
}

describe("memory HTTP routes", () => {
  it("returns recalled claims (filter-only, no embedding)", async () => {
    await withStore(async (store) => {
      await seedClaim(store, "claim-1", [1, 0, 0, 0, 0, 0, 0, 0], "dashboard means gx-admin-client");
      // No `query` → recallClaims ranks by weight under the tag filter, so the
      // dashboard route never loads the embedding model in this test.
      const response = await handleMemoryRecall(store, new URLSearchParams({ tags: "t-claim-1" }));
      expect(response.status).toBe(200);
      const body = (await response.json()) as { results: Array<{ id: string }> };
      expect(body.results.map((result) => result.id)).toContain("claim-1");
    });
  });

  it("returns a well-formed {points, edges} projection for seeded claims", async () => {
    await withStore(async (store) => {
      // Two tight clusters in an 8-dim space: A near e0, B near e1.
      await seedClaim(store, "a1", [1, 0, 0, 0, 0, 0, 0, 0]);
      await seedClaim(store, "a2", [0.95, 0.05, 0, 0, 0, 0, 0, 0]);
      await seedClaim(store, "a3", [0.9, 0.1, 0, 0, 0, 0, 0, 0]);
      await seedClaim(store, "b1", [0, 1, 0, 0, 0, 0, 0, 0]);
      await seedClaim(store, "b2", [0.05, 0.95, 0, 0, 0, 0, 0, 0]);

      const response = await handleMemoryProjection(store);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        points: Array<{
          id: string; x: number; y: number; z: number; kind: string; text: string;
          tags: string[]; repo: string | null; weight: number;
        }>;
        edges: Array<{ a: string; b: string; sim: number }>;
        facets: { tags: Array<{ value: string; count: number }>; kinds: Array<{ value: string; count: number }> };
      };

      expect(body.points).toHaveLength(5);
      const ids = new Set(body.points.map((p) => p.id));
      expect(ids).toEqual(new Set(["a1", "a2", "a3", "b1", "b2"]));
      for (const p of body.points) {
        expect(Number.isFinite(p.x)).toBe(true);
        expect(Number.isFinite(p.y)).toBe(true);
        // The galaxy view needs a third axis — a 2D projection would collapse it.
        expect(Number.isFinite(p.z)).toBe(true);
        expect(p.kind).toBe("fact");
        expect(Array.isArray(p.tags)).toBe(true);
        expect(typeof p.text).toBe("string");
        expect(typeof p.weight).toBe("number");
      }

      // Facets drive the filter chips; they must count the projected points.
      expect(body.facets.kinds).toEqual([{ value: "fact", count: 5 }]);
      expect(body.facets.tags).toHaveLength(5);
      expect(body.facets.tags.every((t) => t.count === 1)).toBe(true);

      expect(body.edges.length).toBeGreaterThan(0);
      for (const e of body.edges) {
        expect(ids.has(e.a)).toBe(true);
        expect(ids.has(e.b)).toBe(true);
        expect(e.a).not.toBe(e.b);
        expect(e.sim).toBeGreaterThanOrEqual(-1.0001);
        expect(e.sim).toBeLessThanOrEqual(1.0001);
      }

      // The nearest neighbour of a1 should be inside cluster A, not cluster B —
      // local neighbourhood structure must survive the cosine KNN.
      const a1Neighbors = body.edges
        .filter((e) => e.a === "a1" || e.b === "a1")
        .sort((x, y) => y.sim - x.sim);
      const top = a1Neighbors[0];
      const partner = top.a === "a1" ? top.b : top.a;
      expect(["a2", "a3"]).toContain(partner);
    });
  });

  it("guards the empty store: no claims → empty points and edges", async () => {
    await withStore(async (store) => {
      const response = await handleMemoryProjection(store);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { points: unknown[]; edges: unknown[] };
      expect(body.points).toEqual([]);
      expect(body.edges).toEqual([]);
    });
  });

  it("guards the single-claim store: one point at the origin, no edges", async () => {
    await withStore(async (store) => {
      await seedClaim(store, "solo", [0.3, 0.7, 0.1, 0, 0, 0, 0, 0]);
      const response = await handleMemoryProjection(store);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        points: Array<{ id: string; x: number; y: number; z: number }>;
        edges: unknown[];
      };
      expect(body.points).toHaveLength(1);
      expect(body.points[0].id).toBe("solo");
      expect(body.points[0].x).toBe(0);
      expect(body.points[0].y).toBe(0);
      expect(body.points[0].z).toBe(0);
      expect(body.edges).toEqual([]);
    });
  });

  it("serves a cache hit for an unchanged claim set, and rebuilds on ?refresh=1", async () => {
    await withStore(async (store) => {
      await seedClaim(store, "c1", [1, 0, 0, 0, 0, 0, 0, 0]);
      await seedClaim(store, "c2", [0, 1, 0, 0, 0, 0, 0, 0]);
      await seedClaim(store, "c3", [0, 0, 1, 0, 0, 0, 0, 0]);

      const first = await handleMemoryProjection(store);
      expect(first.headers.get("X-Projection-Cache")).toBe("miss");
      const firstBody = await first.text();

      const second = await handleMemoryProjection(store);
      expect(second.headers.get("X-Projection-Cache")).toBe("hit");
      expect(await second.text()).toBe(firstBody);

      const forced = await handleMemoryProjection(store, new URLSearchParams({ refresh: "1" }));
      expect(forced.headers.get("X-Projection-Cache")).toBe("miss");
      // The layout is deterministic, so a rebuild of the same corpus is identical.
      expect(await forced.text()).toBe(firstBody);

      // A new claim changes the signature, so the next read must recompute.
      await seedClaim(store, "c4", [0, 0, 0, 1, 0, 0, 0, 0]);
      const afterWrite = await handleMemoryProjection(store);
      expect(afterWrite.headers.get("X-Projection-Cache")).toBe("miss");
      expect((await afterWrite.json()).points).toHaveLength(4);
    });
  });
});
