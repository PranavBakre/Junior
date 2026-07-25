import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAnchorInFile, resolveAnchorRepoWide, verifyStep } from "./anchors.ts";
import {
  REF_FETCH_TIMEOUT_MS,
  resetRefFetchThrottle,
  resolveCanonicalRef,
  routeDrift,
  type GitRefContext,
} from "./freshness.ts";
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

  it("attributes a merge commit's own edits to the path they changed", async () => {
    // `git log --name-only` prints NO file names for a merge commit — git shows
    // no diff for a merge unless one is asked for. This repo's workflow is
    // always 3-way merges, never squash, so a merge carrying a conflict
    // resolution or a build fixup is the norm; without a diff against the first
    // parent the commit is counted but its paths are invisible, and tier 0 then
    // answers `untouched` / `git-untouched` over a file the merge rewrote.
    const base = ctx.sha;
    await repo.checkout("feature/merge-fixup", { create: true });
    repo.write({ "src/shared.ts": SHARED.replace("value * 2", "value * 5") });
    await repo.commit("branch touches shared only");

    await repo.checkout("main");
    await repo.merge("feature/merge-fixup", {
      // Made during the merge, so this edit exists ONLY in the merge commit.
      "src/handler.ts": HANDLER.replace("scaled + 1", "scaled + 2"),
    });
    await repo.publish();
    const next = await resolveCanonicalRef(repo.path);
    if (!next) throw new Error("ref vanished");

    const drift = await routeDrift(next, base, ["src/handler.ts"]);
    expect(drift.commits).toBe(1);
    expect([...drift.changedPaths]).toEqual(["src/handler.ts"]);

    // Sibling paths the merge did not touch keep their tier-0 answer.
    const both = await routeDrift(next, base, ["src/handler.ts", "src/server.ts"]);
    expect([...both.changedPaths]).toEqual(["src/handler.ts"]);

    // On a git without `--diff-merges` (< 2.31) the retry drops the flag and
    // the opaque-commit rule carries correctness instead: the merge names no
    // path, so EVERY scoped path is assumed touched. Less precise, still safe —
    // and unreachable in production on this box, which is why it is forced here.
    // Without this case a tidy-up of the parser could restore the original
    // blocker on an old git with the suite still green.
    const conservative = await routeDrift(
      next,
      base,
      ["src/handler.ts", "src/server.ts"],
      { diffMerges: false },
    );
    expect(conservative.commits).toBe(1);
    expect([...conservative.changedPaths].sort()).toEqual(["src/handler.ts", "src/server.ts"]);
  });

  it("fetches for a fully-qualified remote-tracking defaultBase too", async () => {
    // `remoteTrackingRef` passes a `refs/`-prefixed base through unchanged, so a
    // configured `refs/remotes/origin/main` names a ref that DOES advance on
    // fetch. Testing only the short spelling reported it `skipped` — the status
    // that means "nothing was missed" — and silently disabled the fetch.
    const stale = ctx.sha;
    repo.write({ "src/handler.ts": HANDLER.replace("scaled + 1", "scaled + 6") });
    await repo.commit("later work");
    await repo.publish();
    await repo.rewindOriginRef(stale);
    resetRefFetchThrottle();

    const resolved = await resolveCanonicalRef(repo.path, "refs/remotes/origin/main", {
      fetch: true,
    });
    expect(resolved?.ref).toBe("refs/remotes/origin/main");
    expect(resolved?.fetchStatus).toBe("ok");
    expect(resolved?.sha).not.toBe(stale);
    expect(resolved?.sha).toBe(await repo.originSha());
  });

  it("honours a config-only core.sshCommand instead of clobbering it", async () => {
    // GIT_SSH_COMMAND outranks core.sshCommand, so setting the env var without
    // seeding it from the config drops an operator's deploy key or jump host —
    // auth fails, the fetch reports `failed`, and the ref quietly goes stale.
    const marker = join(repo.path, ".ssh-was-invoked");
    const wrapper = join(repo.path, "fake-ssh.sh");
    writeFileSync(wrapper, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, { mode: 0o755 });
    await repo.gitConfig("core.sshCommand", wrapper);
    await repo.setRemoteUrl("ssh://git@127.0.0.1:1/hung.git");
    resetRefFetchThrottle();

    const resolved = await resolveCanonicalRef(repo.path, undefined, { fetch: true });
    expect(existsSync(marker)).toBe(true);
    // The wrapper refuses, so the fetch fails — and says so rather than
    // pretending the ref is current.
    expect(resolved?.fetchStatus).toBe("failed");
    expect(resolved?.sha).toBe(ctx.sha);
  }, 20_000);

  it("bounds a fetch against a remote that accepts and never answers", async () => {
    // `proc.kill()` alone does NOT bound this: over any helper transport git
    // spawns a separate `git-remote-https` / `ssh` process that inherits the
    // piped stderr, so the pipe never closes and a drain-then-exit read hangs
    // indefinitely (measured 30s+ on https, 25s+ on ssh, orphaned at ppid 1).
    // Only `git://` — which nothing here uses — respected the old bound.
    const hung = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {}, open() {}, close() {}, error() {} },
    });
    try {
      await repo.setRemoteUrl(`https://127.0.0.1:${hung.port}/hung.git`);
      resetRefFetchThrottle();
      const startedAt = Date.now();
      const resolved = await resolveCanonicalRef(repo.path, undefined, { fetch: true });
      const elapsed = Date.now() - startedAt;

      // The bound is what is under test; the slack absorbs process spawn.
      expect(elapsed).toBeLessThan(REF_FETCH_TIMEOUT_MS + 4_000);
      // A failed fetch is not a failed verification: the ref still reads, and
      // the caller is told the fetch did not land.
      expect(resolved?.ref).toBe("origin/main");
      expect(resolved?.sha).toBe(ctx.sha);
      expect(resolved?.fetchStatus).toBe("failed");
    } finally {
      hung.stop(true);
    }
  }, 20_000);

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
