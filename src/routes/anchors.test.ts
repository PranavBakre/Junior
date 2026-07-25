import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { resolveAnchorInFile, resolveAnchorRepoWide, verifyStep } from "./anchors.ts";
import { resolveCanonicalRef, routeDrift, type GitRefContext } from "./freshness.ts";
import { createFixtureRepo, type FixtureRepo } from "./test-fixture.ts";
import type { TaskRouteStepRecord } from "./types.ts";

const HANDLER = `import { shared } from "./shared.ts";

export function handleMemoryProjection(input: number): number {
  const scaled = shared(input);
  return scaled + 1;
}

export const PROJECTION_LIMIT = 200;
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

async function anchorStep(
  ctx: GitRefContext,
  ord: number,
  path: string,
  symbol: string,
  over: Partial<TaskRouteStepRecord> = {},
): Promise<TaskRouteStepRecord> {
  const anchor = await resolveAnchorInFile(ctx, path, symbol);
  if (!anchor) throw new Error(`fixture symbol ${symbol} did not resolve in ${path}`);
  return {
    ord,
    note: `anchor ${symbol}`,
    path: anchor.path,
    symbol,
    declPattern: anchor.declPattern,
    sigHash: anchor.sigHash,
    blockHash: anchor.blockHash,
    expectsRef: null,
    touchCount: 0,
    ...over,
  };
}

describe("task-route anchors", () => {
  let repo: FixtureRepo;
  let ctx: GitRefContext;

  beforeEach(async () => {
    repo = await createFixtureRepo("junior-anchors-");
    repo.write({
      "src/handler.ts": HANDLER,
      "src/server.ts": SERVER,
      "src/shared.ts": SHARED,
    });
    await repo.commit("init");
    await repo.publish();
    const resolved = await resolveCanonicalRef(repo.path);
    if (!resolved) throw new Error("fixture origin/main did not resolve");
    ctx = resolved;
  });

  afterEach(() => {
    repo.cleanup();
  });

  it("resolves origin/main, and nothing at all outside a git repo", async () => {
    expect(ctx.ref).toBe("origin/main");
    expect(ctx.sha).toBe(await repo.originSha());
    expect(await resolveCanonicalRef("/definitely/not/a/repo")).toBeNull();
    expect(await resolveCanonicalRef(null)).toBeNull();
  });

  it("verifies against the ref, not the working tree", async () => {
    const step = await anchorStep(ctx, 1, "src/handler.ts", "handleMemoryProjection");
    // Dirty the checkout without committing — verification must not see it.
    repo.write({ "src/handler.ts": HANDLER.replace("scaled + 1", "scaled + 999") });

    const result = await verifyStep(ctx, step, { untouched: false });
    expect(result.status).toBe("ok");
    expect(result.tier).toBe(1);
    expect(result.verifiedBy).toBe("fingerprint");
  });

  it("reports tier 0 untouched without opening the file", async () => {
    const step = await anchorStep(ctx, 1, "src/handler.ts", "handleMemoryProjection");
    const result = await verifyStep(ctx, step, { untouched: true });
    expect(result.status).toBe("untouched");
    expect(result.tier).toBe(0);
    expect(result.verifiedBy).toBe("git-untouched");
  });

  it("reports drifted when the block changes underneath the anchor", async () => {
    const step = await anchorStep(ctx, 1, "src/handler.ts", "handleMemoryProjection");
    repo.write({ "src/handler.ts": HANDLER.replace("return scaled + 1;", "return scaled * 3;") });
    await repo.commit("change body");
    await repo.publish();

    const result = await verifyStep(ctx, step, { untouched: false });
    expect(result.status).toBe("drifted");
    expect(result.tier).toBe(1);
    expect(result.verifiedBy).toBe("fingerprint");
    expect(result.repair).toBeUndefined();
  });

  it("resolves a symbol that MOVED to another file via tier 2 and offers a repair", async () => {
    const step = await anchorStep(ctx, 1, "src/handler.ts", "handleMemoryProjection");
    repo.write({
      // The declaration moves out; the old file keeps importing it, which a
      // loose match would mistake for the symbol still living here.
      "src/handler.ts": `import { handleMemoryProjection } from "./projection.ts";\n\nexport const PROJECTION_LIMIT = 200;\nexport { handleMemoryProjection };\n`,
      "src/projection.ts": `import { shared } from "./shared.ts";\n\nexport function handleMemoryProjection(input: number): number {\n  const scaled = shared(input);\n  return scaled + 1;\n}\n`,
    });
    await repo.commit("extract projection");
    await repo.publish();

    const result = await verifyStep(ctx, step, { untouched: false });
    expect(result.status).toBe("moved");
    expect(result.tier).toBe(2);
    expect(result.verifiedBy).toBe("decl-pattern");
    expect(result.resolvedPath).toBe("src/projection.ts");
    expect(result.repair?.path).toBe("src/projection.ts");
    // The moved body is unchanged, so the repaired fingerprint matches the old one.
    if (step.blockHash === null) throw new Error("fixture anchor was never fingerprinted");
    expect(result.repair?.blockHash).toBe(step.blockHash);
  });

  it("reports gone when the symbol is deleted outright", async () => {
    const step = await anchorStep(ctx, 1, "src/handler.ts", "handleMemoryProjection");
    repo.write({
      "src/handler.ts": "export const PROJECTION_LIMIT = 200;\n",
      "src/server.ts": "export function route(input: number) {\n  return input;\n}\n",
    });
    await repo.commit("delete projection");
    await repo.publish();

    const result = await verifyStep(ctx, step, { untouched: false });
    expect(result.status).toBe("gone");
    expect(result.tier).toBe(2);
  });

  it("reports gone when the whole file disappears and nothing else declares the symbol", async () => {
    const step = await anchorStep(ctx, 1, "src/shared.ts", "shared");
    repo.remove(["src/shared.ts", "src/handler.ts", "src/server.ts"]);
    repo.write({ "src/other.ts": "export const nothing = 1;\n" });
    await repo.commit("remove everything");
    await repo.publish();

    const result = await verifyStep(ctx, step, { untouched: false });
    expect(result.status).toBe("gone");
  });

  it("reports edge-broken when expects_ref is no longer in the file", async () => {
    const step = await anchorStep(ctx, 1, "src/server.ts", "route", {
      expectsRef: "handleMemoryProjection",
    });
    repo.write({
      "src/server.ts": "export function route(input: number) {\n  return input;\n}\n",
    });
    await repo.commit("drop the edge");
    await repo.publish();

    const result = await verifyStep(ctx, step, { untouched: false });
    expect(result.status).toBe("edge-broken");
    expect(result.tier).toBe(3);
    expect(result.verifiedBy).toBe("expects-ref");
  });

  it("keeps a step ok while its expects_ref edge survives", async () => {
    const step = await anchorStep(ctx, 1, "src/server.ts", "route", {
      expectsRef: "handleMemoryProjection",
    });
    const result = await verifyStep(ctx, step, { untouched: false });
    expect(result.status).toBe("ok");
    expect(result.tier).toBe(1);
  });

  it("treats a path-only step as weaker evidence than a fingerprint", async () => {
    const step: TaskRouteStepRecord = {
      ord: 1,
      note: "the whole file matters",
      path: "src/handler.ts",
      symbol: null,
      declPattern: null,
      sigHash: null,
      blockHash: null,
      expectsRef: null,
      touchCount: 0,
    };
    const result = await verifyStep(ctx, step, { untouched: false });
    expect(result.status).toBe("ok");
    expect(result.verifiedBy).toBe("path-only");
    expect(result.tier).toBe(0);
  });

  it("treats a pure tooling note as a note, with no tier", async () => {
    const step: TaskRouteStepRecord = {
      ord: 1,
      note: "DEAD END: the Chrome extension is not connected; use local Playwright",
      path: null,
      symbol: null,
      declPattern: null,
      sigHash: null,
      blockHash: null,
      expectsRef: null,
      touchCount: 0,
    };
    const result = await verifyStep(ctx, step, { untouched: false });
    expect(result.status).toBe("note");
    expect(result.tier).toBeNull();
  });

  it("holds an anchor that only exists on an unmerged branch as pending", async () => {
    await repo.checkout("feature/x", { create: true });
    repo.write({ "src/unmerged.ts": "export function futureThing() {\n  return 1;\n}\n" });
    await repo.commit("unmerged work");

    // Nothing is pushed, so origin/main still has no such file.
    expect(await resolveAnchorInFile(ctx, "src/unmerged.ts", "futureThing")).toBeNull();

    const pending: TaskRouteStepRecord = {
      ord: 1,
      note: "the new thing",
      path: "src/unmerged.ts",
      symbol: "futureThing",
      declPattern: null,
      sigHash: null,
      blockHash: null,
      expectsRef: null,
      touchCount: 0,
    };
    const before = await verifyStep(ctx, pending, { untouched: false });
    expect(before.status).toBe("pending");
    expect(before.verifiedBy).toBe("none");

    // Once it merges, the next fetch activates it for free.
    await repo.publish();
    const merged = await resolveCanonicalRef(repo.path);
    const after = await verifyStep(ctx, pending, { untouched: false });
    expect(merged?.sha).not.toBe(ctx.sha);
    expect(after.status).toBe("ok");
    expect(after.repair?.path).toBe("src/unmerged.ts");
  });

  it("scopes drift to the route's own paths and names which of them changed", async () => {
    const base = ctx.sha;
    repo.write({ "src/shared.ts": SHARED.replace("value * 2", "value * 4") });
    await repo.commit("touch shared only");
    await repo.publish();
    const next = await resolveCanonicalRef(repo.path);
    if (!next) throw new Error("ref vanished");

    const unrelated = await routeDrift(next, base, ["src/handler.ts"]);
    expect(unrelated.commits).toBe(0);

    const related = await routeDrift(next, base, ["src/handler.ts", "src/shared.ts"]);
    expect(related.commits).toBe(1);
    expect([...related.changedPaths]).toEqual(["src/shared.ts"]);
  });

  it("reports unknown drift for a sha the repo has never seen", async () => {
    const drift = await routeDrift(ctx, "0".repeat(40), ["src/handler.ts"]);
    expect(drift.commits).toBeNull();
  });

  it("does not resolve a call site as a declaration during a repo-wide search", async () => {
    // `route` is declared in server.ts and never anywhere else; a bare-occurrence
    // search would also hit any file merely mentioning it.
    const found = await resolveAnchorRepoWide(ctx, "route", null);
    expect(found?.path).toBe("src/server.ts");
    expect(await resolveAnchorRepoWide(ctx, "route", null, "src/server.ts")).toBeNull();
  });
});
