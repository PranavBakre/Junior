import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { HashingEmbeddingProvider } from "../memory/embedding/hashing.ts";
import { resetRefFetchThrottle, resolveCanonicalRef } from "./freshness.ts";
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
    resetRefFetchThrottle();
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

  const fetchIt = (over: Partial<Parameters<typeof routeFetch>[0]> = {}) =>
    routeFetch(
      {
        repo: "fixture",
        task: "add a filter",
        feature: "memory-projection",
        taskKind: "add-ui-surface",
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
    // Every `unresolved` reason a save can return is relative to this ref, so
    // the same fetch signal route_fetch reports has to be reported here too.
    expect(result.ref_fetch).toBe("ok");
    expect(result.ref_committed_at).not.toBeNull();

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

  it("sees an edit that arrived as a merge commit, and does not bump past it", async () => {
    // The workflow here is always 3-way merges, never squash, so a merge that
    // carries a conflict resolution or a build fixup is ordinary. Such an edit
    // exists only in the merge commit, which `git log --name-only` describes
    // with no file names at all — so the step used to answer `untouched` with
    // `verified_by: git-untouched`, the strongest label in the system, while
    // the fingerprint said `drifted`. It then self-concealed: a clean fetch
    // bumps verified_sha past the merge and the next log sees zero commits.
    const saved = await save();
    const originalSha = (await store.getRoute(saved.route_id))?.verifiedSha;

    await repo.checkout("feature/merge-fixup", { create: true });
    repo.write({ "src/shared.ts": SHARED.replace("value * 2", "value * 5") });
    await repo.commit("branch work elsewhere");
    await repo.checkout("main");
    await repo.merge("feature/merge-fixup", {
      "src/handler.ts": HANDLER.replace("return scaled + 1;", "return scaled * 9;"),
    });
    await repo.publish();

    const result = await fetchIt();
    assertFound(result);
    expect(result.drift).toBe("1 commit");
    expect(result.steps[0].status).toBe("drifted");
    expect(result.steps[0].verified_by).toBe("fingerprint");
    // The file the merge did not touch keeps its cheap tier-0 answer.
    expect(result.steps[1].status).toBe("untouched");
    expect((await store.getRoute(saved.route_id))?.verifiedSha).toBe(originalSha);
  });

  it("normalises the identity, so two spellings are one route", async () => {
    // `Add-UI-Surface` and `add-ui-surface` slugged to the same route id but
    // NOT to the same ON CONFLICT target, so the second save hit a raw
    // `UNIQUE constraint failed: task_route.id` and could never be stored.
    const first = await save();
    const second = await save({
      feature: "Memory Projection",
      taskKind: "Add-UI-Surface",
      taskDesc: "rewritten",
      steps: [{ note: "just one step now", path: "src/shared.ts", symbol: "shared" }],
    });

    expect(second.route_id).toBe(first.route_id);
    expect(second.identity).toEqual({
      repo: "fixture",
      feature: "memory-projection",
      task_kind: "add-ui-surface",
    });
    expect(second.overwrote).toBe(true);
    expect(second.previous_steps).toBe(3);
    expect(first.overwrote).toBe(false);
    expect(await store.listRouteIdentities("fixture")).toEqual([
      { feature: "memory-projection", taskKind: "add-ui-surface", active: true },
    ]);

    // And the odd spelling finds it again on the way back out.
    const found = await fetchIt({ feature: "Memory Projection", taskKind: "Add UI Surface" });
    assertFound(found);
    expect(found.route_id).toBe(first.route_id);
    expect(found.matched_by).toBe("identity");
  });

  it("rejects an identity part with nothing to slug", async () => {
    await expect(save({ feature: "***" })).rejects.toThrow(/letter or digit/);
  });

  it("takes an absolute path inside the checkout and rejects one outside it", async () => {
    // The workspace agent instructions mandate absolute paths, so route_save
    // receives them routinely — and `git show <ref>:<path>` accepts only
    // repo-relative ones. Unhandled, every such step was recorded `pending`
    // ("until it merges" — the wrong cause) and the route was never activated.
    const inside = await save({
      steps: [
        {
          note: "the projection entry point",
          path: join(repo.path, "src/handler.ts"),
          symbol: "handleMemoryProjection",
        },
      ],
    });
    expect(inside.resolved).toBe(1);
    expect(inside.unresolved).toEqual([]);
    expect(inside.active).toBe(true);
    expect((await store.getRoute(inside.route_id))?.steps[0].path).toBe("src/handler.ts");

    const outside = await save({
      feature: "elsewhere",
      steps: [
        {
          note: "a path from another checkout entirely",
          path: "/Users/someone/other-repo/src/handler.ts",
          symbol: "handleMemoryProjection",
        },
      ],
    });
    expect(outside.active).toBe(false);
    expect(outside.unresolved).toHaveLength(1);
    expect(outside.unresolved[0].reason).toContain("not inside the repo checkout");
    expect(outside.unresolved[0].reason).not.toContain("pending");

    // A relative path that escapes the root is the same mistake wearing a
    // different hat, and must not degrade to "pending until it merges" either.
    const escaping = await save({
      feature: "escaping",
      steps: [{ note: "up and out", path: "../other-repo/src/handler.ts" }],
    });
    expect(escaping.active).toBe(false);
    expect(escaping.unresolved[0].reason).toContain("not inside the repo checkout");

    // And a mid-path `..` is the same escape wearing a disguise — the guard
    // collapses the path rather than pattern-matching its prefix.
    const midPath = await save({
      feature: "mid-path",
      steps: [{ note: "sneaking out", path: "src/../../other-repo/src/handler.ts" }],
    });
    expect(midPath.unresolved[0].reason).toContain("not inside the repo checkout");
  });

  it("reports an expects_ref that is not in the file at save time", async () => {
    // Unchecked, a typo survives the first fetch (tier 0 short-circuits before
    // the edge check), then flips the step to edge-broken forever — and three
    // such fetches archive the route over a typo, not a code change.
    const result = await save({
      steps: [
        {
          note: "the route table hands off to it",
          path: "src/server.ts",
          symbol: "route",
          expectsRef: "handleMemoryProjektion",
        },
      ],
    });
    expect(result.resolved).toBe(1);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0].reason).toContain("expects_ref");
    expect(result.unresolved[0].reason).toContain("src/server.ts");

    const good = await save({
      feature: "good-edge",
      steps: [
        {
          note: "the route table hands off to it",
          path: "src/server.ts",
          symbol: "route",
          expectsRef: "handleMemoryProjection",
        },
      ],
    });
    expect(good.unresolved).toEqual([]);
  });

  it("advances origin before verifying, and dates the ref it verified against", async () => {
    // Nothing else in this feature fetches, so without this a route could read
    // `untouched` / `git-untouched` — maximum confidence — against a tree three
    // weeks stale, and the reader could not tell.
    const saved = await save();
    const savedSha = (await store.getRoute(saved.route_id))?.verifiedSha;
    const staleSha = await repo.originSha();
    repo.write({ "src/handler.ts": HANDLER.replace("return scaled + 1;", "return scaled * 4;") });
    await repo.commit("later work");
    await repo.publish();
    // Pretend this box has not fetched since the save.
    await repo.rewindOriginRef(staleSha);
    resetRefFetchThrottle();

    const result = await fetchIt();
    assertFound(result);
    expect(result.ref_committed_at).not.toBeNull();
    expect(result.ref_fetch).toBe("ok");
    expect(result.drift).toBe("1 commit");
    expect(result.steps[0].status).toBe("drifted");
    // The drift is only visible because the ref moved; the sha stays put while
    // that step is outstanding.
    expect(savedSha).toBe(staleSha);
    expect((await store.getRoute(saved.route_id))?.verifiedSha).toBe(staleSha);

    // Throttled: a second fetch inside the window must NOT re-hit the network.
    // Rewinding again and seeing `untouched` is the proof — had it fetched, the
    // ref would have been restored and the drift would read "1 commit" again.
    await repo.rewindOriginRef(staleSha);
    const throttled = await fetchIt();
    assertFound(throttled);
    expect(throttled.ref_fetch).toBe("throttled");
    expect(throttled.drift).toBe("untouched");
  });

  it("does not blame an unmerged branch when the fetch is what failed", async () => {
    // The executed failure: the symbol IS on the remote's main, this box's
    // tracking ref is behind, and the fetch could not fix that. Reporting only
    // "pending until it merges" names a cause that does not exist — nothing is
    // waiting to merge — and stores the route inactive and unsearchable.
    const stale = await repo.originSha();
    repo.write({ "src/late.ts": "export function lateThing() {\n  return 1;\n}\n" });
    await repo.commit("landed on main");
    await repo.publish();
    await repo.rewindOriginRef(stale);
    // Refused, not hung: the point is a failed fetch, not the timeout path.
    await repo.setRemoteUrl("ssh://git@127.0.0.1:1/nope.git");
    resetRefFetchThrottle();

    const result = await save({
      steps: [{ note: "the late arrival", path: "src/late.ts", symbol: "lateThing" }],
    });
    expect(result.ref_fetch).toBe("failed");
    expect(result.ref_committed_at).not.toBeNull();
    expect(result.active).toBe(false);
    expect(result.unresolved[0].reason).toContain("pending until it merges");
    expect(result.unresolved[0].reason).toContain("may be behind the remote");
  }, 20_000);

  it("names the repo's known identities on a miss", async () => {
    await save();
    const miss = await routeFetch(
      { repo: "fixture", task: "rotate the postgres credentials", feature: "nope", taskKind: "nada" },
      deps,
    );
    if (miss.found) throw new Error("expected a miss");
    expect(miss.known).toEqual([
      { feature: "memory-projection", task_kind: "add-ui-surface", active: true },
    ]);
  });

  it("an unreadable repo neither advances nor resets the broken streak", async () => {
    const saved = await save();
    repo.write({
      "src/handler.ts": "export const nothing = 1;\n",
      "src/server.ts": "export const alsoNothing = 2;\n",
    });
    await repo.commit("gut it");
    await repo.publish();

    await fetchIt();
    await fetchIt();
    expect((await store.getRoute(saved.route_id))?.brokenFetches).toBe(2);

    const offline: TaskRouteToolDeps = { ...deps, resolveRepoPath: () => null };
    const unknown = await routeFetch(
      {
        repo: "fixture",
        task: "add a filter",
        feature: "memory-projection",
        taskKind: "add-ui-surface",
      },
      offline,
    );
    assertFound(unknown);
    // The streak is evidence about the route; an unreadable checkout is no
    // evidence at all, so it must neither advance NOR reset it.
    expect((await store.getRoute(saved.route_id))?.brokenFetches).toBe(2);

    const third = await fetchIt();
    assertFound(third);
    expect(third.archived).toBe(true);
  });

  it("activates a pending anchor whose file was renamed before it merged", async () => {
    await repo.checkout("feature/renamed", { create: true });
    repo.write({ "src/panel.ts": "export function renderPanel() {\n  return null;\n}\n" });
    await repo.commit("unmerged work");

    const saved = await save({
      steps: [
        { note: "the new panel", path: "src/panel.ts", symbol: "renderPanel" },
        {
          note: "the projection entry point",
          path: "src/handler.ts",
          symbol: "handleMemoryProjection",
        },
      ],
    });
    expect(saved.resolved).toBe(1);

    // It merges under a different name than the one the agent recorded.
    await repo.checkout("main");
    repo.write({ "src/panels/panel.ts": "export function renderPanel() {\n  return null;\n}\n" });
    await repo.commit("land the panel, renamed");
    await repo.publish();

    const result = await fetchIt();
    assertFound(result);
    expect(result.steps[0].status).toBe("moved");
    expect(result.steps[0].resolved_path).toBe("src/panels/panel.ts");
    expect(result.repaired).toEqual([1]);
    expect((await store.getRoute(saved.route_id))?.steps[0].path).toBe("src/panels/panel.ts");
  });

  it("does not activate a pending anchor onto its own import line", async () => {
    await repo.checkout("feature/import-only", { create: true });
    repo.write({ "src/panel.ts": "export function renderPanel() {\n  return null;\n}\n" });
    await repo.commit("unmerged work");

    const saved = await save({
      steps: [{ note: "the new panel", path: "src/panel.ts", symbol: "renderPanel" }],
    });

    // It lands elsewhere, leaving only a re-export behind at the recorded path.
    await repo.checkout("main");
    repo.write({
      "src/panel.ts": `import { renderPanel } from "./panels/render.ts";\n\nexport { renderPanel };\n`,
      "src/panels/render.ts": "export function renderPanel() {\n  return null;\n}\n",
    });
    await repo.commit("land it elsewhere");
    await repo.publish();

    const result = await fetchIt();
    assertFound(result);
    // A loose bare-occurrence match would have fingerprinted the import line and
    // called it `ok` at the old path — a pattern the agent never asserted.
    expect(result.steps[0].status).toBe("moved");
    expect(result.steps[0].resolved_path).toBe("src/panels/render.ts");
    expect((await store.getRoute(saved.route_id))?.steps[0].path).toBe("src/panels/render.ts");
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
