import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { HashingEmbeddingProvider } from "../memory/embedding/hashing.ts";
import { resolveCanonicalRef } from "./freshness.ts";
import { InMemoryTaskRouteStore } from "./store/memory.ts";
import { createFixtureRepo, type FixtureRepo } from "./test-fixture.ts";
import {
  routeFetch,
  routeReportUsage,
  routeSave,
  type RouteFetchResult,
  type TaskRouteToolDeps,
} from "./tools.ts";

const HANDLER = `import { shared } from "./shared.ts";

export function handleMemoryProjection(input: number): number {
  const scaled = shared(input);
  return scaled + 1;
}
`;

const SERVER = `import { handleMemoryProjection } from "./handler.ts";

export function route(input: number) {
  return handleMemoryProjection(input);
}
`;

const SHARED = `export function shared(value: number): number {
  return value * 2;
}
`;

function assertFound(
  result: Awaited<ReturnType<typeof routeFetch>>,
): asserts result is RouteFetchResult {
  if (!result.found) throw new Error(`expected a route, got: ${result.reason}`);
}

describe("task-route tools", () => {
  let repo: FixtureRepo;
  let store: InMemoryTaskRouteStore;
  let deps: TaskRouteToolDeps;

  const baseSteps = [
    {
      note: "the projection entry point",
      path: "src/handler.ts",
      symbol: "handleMemoryProjection",
    },
    {
      note: "the route table hands off to it",
      path: "src/server.ts",
      symbol: "route",
      expectsRef: "handleMemoryProjection",
    },
    {
      note: "DEAD END: the Chrome extension is not connected; use local Playwright",
    },
  ];

  beforeEach(async () => {
    repo = await createFixtureRepo("junior-route-tools-");
    repo.write({
      "src/handler.ts": HANDLER,
      "src/server.ts": SERVER,
      "src/shared.ts": SHARED,
    });
    await repo.commit("init");
    await repo.publish();
    store = new InMemoryTaskRouteStore();
    deps = {
      store,
      embedder: new HashingEmbeddingProvider(64),
      resolveRepoPath: (name) => (name === "fixture" ? repo.path : null),
    };
  });

  afterEach(() => {
    store.close();
    repo.cleanup();
  });

  const save = (over: Partial<Parameters<typeof routeSave>[0]> = {}) =>
    routeSave(
      {
        repo: "fixture",
        feature: "memory-projection",
        taskKind: "add-ui-surface",
        taskDesc: "add a filter to the memory projection view",
        steps: baseSteps,
        ...over,
      },
      deps,
    );

  it("saves a route, fingerprinting every anchored step against origin/main", async () => {
    const result = await save();
    expect(result.resolved).toBe(2);
    expect(result.unresolved).toEqual([]);
    expect(result.ref).toBe("origin/main");
    expect(result.verified_sha).toBe(await repo.originSha());
    expect(result.active).toBe(true);

    const stored = await store.getRoute(result.route_id);
    expect(stored?.steps).toHaveLength(3);
    expect(stored?.steps[0].sigHash).not.toBeNull();
    // The pure tooling note gets equal billing and no fingerprint.
    expect(stored?.steps[2].path).toBeNull();
    expect(stored?.steps[2].sigHash).toBeNull();
  });

  it("rejects more than eight steps — the cap is the feature", async () => {
    const nine = Array.from({ length: 9 }, (_, i) => ({ note: `step ${i + 1}` }));
    await expect(save({ steps: nine })).rejects.toThrow(/8-step cap/);
    const tooFew = save({ steps: [] });
    await expect(tooFew).rejects.toThrow(/at least one step/);
  });

  it("fetches by exact identity and reports which tier answered each step", async () => {
    const saved = await save();
    const result = await routeFetch(
      {
        repo: "fixture",
        task: "add a filter",
        feature: "memory-projection",
        taskKind: "add-ui-surface",
      },
      deps,
    );
    assertFound(result);

    expect(result.route_id).toBe(saved.route_id);
    expect(result.matched_by).toBe("identity");
    expect(result.drift).toBe("untouched");
    expect(result.steps.map((s) => s.status)).toEqual(["untouched", "untouched", "note"]);
    expect(result.steps.map((s) => s.verified_by)).toEqual([
      "git-untouched",
      "git-untouched",
      "none",
    ]);
    expect(result.steps.map((s) => s.tier)).toEqual([0, 0, null]);
    expect(result.confidence.untouched).toBe(2);
    expect(result.confidence.note).toBe(1);

    const after = await store.getRoute(saved.route_id);
    expect(after?.fetchCount).toBe(1);
    expect(after?.lastUsedAt).not.toBeNull();
  });

  it("finds a route semantically when the caller does not know the identity", async () => {
    const saved = await save();
    const result = await routeFetch(
      { repo: "fixture", task: "add a filter to the memory projection view" },
      deps,
    );
    assertFound(result);
    expect(result.route_id).toBe(saved.route_id);
    expect(result.matched_by).toBe("semantic");
  });

  it("misses rather than returning the nearest unrelated route", async () => {
    await save();
    const result = await routeFetch(
      { repo: "fixture", task: "rotate the postgres credentials in terraform" },
      deps,
    );
    expect(result.found).toBe(false);
    const wrongRepo = await routeFetch({ repo: "elsewhere", task: "add a filter" }, deps);
    expect(wrongRepo.found).toBe(false);
  });

  it("auto-repairs a moved symbol with no agent involvement", async () => {
    const saved = await save();
    repo.write({
      "src/handler.ts": `import { handleMemoryProjection } from "./projection.ts";\n\nexport { handleMemoryProjection };\n`,
      "src/projection.ts": `import { shared } from "./shared.ts";\n\nexport function handleMemoryProjection(input: number): number {\n  const scaled = shared(input);\n  return scaled + 1;\n}\n`,
    });
    await repo.commit("extract projection");
    await repo.publish();

    const result = await routeFetch(
      {
        repo: "fixture",
        task: "add a filter",
        feature: "memory-projection",
        taskKind: "add-ui-surface",
      },
      deps,
    );
    assertFound(result);
    expect(result.drift).toBe("1 commit");
    expect(result.steps[0].status).toBe("moved");
    expect(result.steps[0].tier).toBe(2);
    expect(result.steps[0].resolved_path).toBe("src/projection.ts");
    expect(result.steps[0].path).toBe("src/projection.ts");
    expect(result.repaired).toEqual([1]);

    const after = await store.getRoute(saved.route_id);
    expect(after?.repairCount).toBe(1);
    expect(after?.steps[0].path).toBe("src/projection.ts");
    // Everything came back clean, so the route re-anchors on the new commit and
    // the NEXT fetch is a tier-0 answer again.
    expect(after?.verifiedSha).toBe(await repo.originSha());

    const second = await routeFetch(
      {
        repo: "fixture",
        task: "add a filter",
        feature: "memory-projection",
        taskKind: "add-ui-surface",
      },
      deps,
    );
    assertFound(second);
    expect(second.steps[0].status).toBe("untouched");
    expect(second.repaired).toEqual([]);
  });

  it("does not bump verified_sha while a step is still drifted", async () => {
    const saved = await save();
    const originalSha = (await store.getRoute(saved.route_id))?.verifiedSha;
    repo.write({ "src/handler.ts": HANDLER.replace("scaled + 1", "scaled * 7") });
    await repo.commit("change the body");
    await repo.publish();

    const result = await routeFetch(
      {
        repo: "fixture",
        task: "add a filter",
        feature: "memory-projection",
        taskKind: "add-ui-surface",
      },
      deps,
    );
    assertFound(result);
    expect(result.steps[0].status).toBe("drifted");
    // Step 2's file was not in the changed set, so it stays a tier-0 answer.
    expect(result.steps[1].status).toBe("untouched");
    expect((await store.getRoute(saved.route_id))?.verifiedSha).toBe(originalSha);
  });

  it("reports edge-broken when the recorded edge disappears", async () => {
    await save();
    repo.write({ "src/server.ts": "export function route(input: number) {\n  return input;\n}\n" });
    await repo.commit("drop the handoff");
    await repo.publish();

    const result = await routeFetch(
      {
        repo: "fixture",
        task: "add a filter",
        feature: "memory-projection",
        taskKind: "add-ui-surface",
      },
      deps,
    );
    assertFound(result);
    expect(result.steps[1].status).toBe("edge-broken");
    expect(result.steps[1].tier).toBe(3);
    expect(result.confidence["edge-broken"]).toBe(1);
  });

  it("archives — never deletes — a route whose anchors are mostly gone", async () => {
    const saved = await save();
    repo.write({
      "src/handler.ts": "export const nothing = 1;\n",
      "src/server.ts": "export const alsoNothing = 2;\n",
    });
    await repo.commit("gut it");
    await repo.publish();

    const fetchIt = () =>
      routeFetch(
        {
          repo: "fixture",
          task: "add a filter",
          feature: "memory-projection",
          taskKind: "add-ui-surface",
        },
        deps,
      );

    const first = await fetchIt();
    assertFound(first);
    expect(first.confidence.gone).toBe(2);
    expect(first.archived).toBe(false);
    expect((await fetchIt()).found).toBe(true);
    const third = await fetchIt();
    assertFound(third);
    expect(third.archived).toBe(true);

    const stored = await store.getRoute(saved.route_id);
    expect(stored).not.toBeNull();
    expect(stored?.active).toBe(false);
    // Archived is invisible to search but still reachable by exact identity.
    const semantic = await routeFetch(
      { repo: "fixture", task: "add a filter to the memory projection view" },
      deps,
    );
    expect(semantic.found).toBe(false);
    expect((await fetchIt()).found).toBe(true);
  });

  it("reports unknown — never ok — when the repo is not on this box", async () => {
    const saved = await save();
    deps = { ...deps, resolveRepoPath: () => null };
    const result = await routeFetch(
      {
        repo: "fixture",
        task: "add a filter",
        feature: "memory-projection",
        taskKind: "add-ui-surface",
      },
      deps,
    );
    assertFound(result);
    expect(result.ref).toBeNull();
    expect(result.drift).toBe("unknown");
    expect(result.steps.map((s) => s.status)).toEqual(["unknown", "unknown", "note"]);
    expect(result.steps.every((s) => s.verified_by === "none")).toBe(true);
    // An unreadable repo must not archive a perfectly good route.
    expect(result.archived).toBe(false);
    expect((await store.getRoute(saved.route_id))?.active).toBe(true);
  });

  it("saves anchors from an unmerged branch as pending, and activates them on merge", async () => {
    await repo.checkout("feature/new-surface", { create: true });
    repo.write({ "src/panel.ts": "export function renderPanel() {\n  return null;\n}\n" });
    await repo.commit("unmerged work");

    const saved = await save({
      steps: [
        { note: "the new panel", path: "src/panel.ts", symbol: "renderPanel" },
        { note: "the projection entry point", path: "src/handler.ts", symbol: "handleMemoryProjection" },
      ],
    });
    expect(saved.resolved).toBe(1);
    expect(saved.unresolved).toHaveLength(1);
    expect(saved.unresolved[0].reason).toContain("pending");
    expect((await store.getRoute(saved.route_id))?.steps[0].sigHash).toBeNull();

    const fetchIt = () =>
      routeFetch(
        {
          repo: "fixture",
          task: "add a filter",
          feature: "memory-projection",
          taskKind: "add-ui-surface",
        },
        deps,
      );

    const before = await fetchIt();
    assertFound(before);
    expect(before.steps[0].status).toBe("pending");

    await repo.publish();
    const after = await fetchIt();
    assertFound(after);
    expect(after.steps[0].status).toBe("ok");
    expect(after.repaired).toEqual([1]);
    expect((await store.getRoute(saved.route_id))?.steps[0].sigHash).not.toBeNull();
  });

  it("leaves a route inactive until an anchor lands on the canonical ref", async () => {
    await repo.checkout("feature/only-new", { create: true });
    repo.write({ "src/only.ts": "export function onlyHere() {\n  return 1;\n}\n" });
    await repo.commit("unmerged");

    const saved = await save({
      steps: [{ note: "the only step", path: "src/only.ts", symbol: "onlyHere" }],
    });
    expect(saved.active).toBe(false);
    expect(saved.resolved).toBe(0);

    // Not searchable, but exact identity revives it once the work merges.
    const semantic = await routeFetch(
      { repo: "fixture", task: "add a filter to the memory projection view" },
      deps,
    );
    expect(semantic.found).toBe(false);

    await repo.publish();
    const revived = await routeFetch(
      {
        repo: "fixture",
        task: "add a filter",
        feature: "memory-projection",
        taskKind: "add-ui-surface",
      },
      deps,
    );
    assertFound(revived);
    expect(revived.steps[0].status).toBe("ok");
    expect(revived.active).toBe(true);
  });

  it("overwrites the route at the same identity rather than adding a second one", async () => {
    const first = await save();
    const second = await save({
      taskDesc: "rewritten",
      steps: [{ note: "just one step now", path: "src/shared.ts", symbol: "shared" }],
    });
    expect(second.route_id).toBe(first.route_id);
    const stored = await store.getRoute(first.route_id);
    expect(stored?.taskDesc).toBe("rewritten");
    expect(stored?.steps).toHaveLength(1);
  });

  it("records reported usage, and refuses an unknown route", async () => {
    const saved = await save();
    const reported = await routeReportUsage({ routeId: saved.route_id, usedOrds: [1, 3] }, deps);
    expect(reported).toEqual({ ok: true, updated: 2 });
    const stored = await store.getRoute(saved.route_id);
    expect(stored?.steps.map((s) => s.touchCount)).toEqual([1, 0, 1]);

    const missing = await routeReportUsage({ routeId: "route_nope", usedOrds: [1] }, deps);
    expect(missing.ok).toBe(false);
    expect(missing.updated).toBe(0);
  });

  it("does not prune or promote on touch_count — that rule is gated on adoption", async () => {
    const saved = await save();
    await routeReportUsage({ routeId: saved.route_id, usedOrds: [1] }, deps);
    for (let i = 0; i < 5; i += 1) {
      await routeFetch(
        {
          repo: "fixture",
          task: "add a filter",
          feature: "memory-projection",
          taskKind: "add-ui-surface",
        },
        deps,
      );
    }
    const stored = await store.getRoute(saved.route_id);
    expect(stored?.steps).toHaveLength(3);
    expect(stored?.steps.map((s) => s.ord)).toEqual([1, 2, 3]);
  });

  it("falls back to the process cwd when Junior is itself the repo", async () => {
    const cwdRepo = process.cwd().split("/").pop() as string;
    const ctx = await resolveCanonicalRef(process.cwd());
    const result = await routeFetch({ repo: cwdRepo, task: "anything" }, deps);
    // No route exists for Junior here — the point is that the lookup does not
    // crash on the cwd fallback, whether or not the ref resolves.
    expect(result.found).toBe(false);
    expect(ctx === null || ctx.ref.startsWith("origin/")).toBe(true);
  });
});
