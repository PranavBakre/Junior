import { describe, expect, it } from "bun:test";
import { InMemoryPipelineStore } from "../pipelines/store/memory.ts";
import { makeProductRun } from "../pipelines/store/test-helpers.ts";
import { fakeClock } from "../time/clock.ts";
import type { FetchPrResult, GitHubClient } from "./client.ts";
import {
  computeBackoffMs,
  nextPollAtForClass,
  reconcileTrackedResources,
  shouldReconcileForWakeGap,
} from "./reconciler.ts";
import type { GitHubResource, PrSnapshot } from "./types.ts";
import {
  GITHUB_BACKOFF_CEILING_MS,
  GITHUB_POLL_HOT_MS,
  GITHUB_POLL_WARM_MS,
} from "./types.ts";

function snap(overrides: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    headRefName: "feat",
    headRefOid: "sha-old",
    reviewDecision: null,
    mergeable: "MERGEABLE",
    mergedAt: null,
    closedAt: null,
    checkRollup: "PENDING",
    checkRollupSha: "sha-old",
    updatedAt: "t0",
    ...overrides,
  };
}

function makeResource(
  overrides: Partial<GitHubResource> = {},
): GitHubResource {
  const now = 1_000;
  return {
    id: "res-1",
    kind: "pull_request",
    owner: "acme",
    repo: "widgets",
    number: 10,
    nodeId: "PR_10",
    snapshot: snap(),
    lastPolledAt: now,
    nextPollAt: now,
    pollClass: "hot",
    consecutiveFailures: 0,
    lastError: null,
    leaseOwner: null,
    leaseUntil: null,
    terminalAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function fakeClient(
  byCoords: Map<string, FetchPrResult>,
): GitHubClient {
  return {
    async fetchPullRequest(owner, repo, number) {
      return (
        byCoords.get(`${owner}/${repo}#${number}`) ?? {
          ok: false,
          error: "not stubbed",
        }
      );
    },
    async fetchPullRequestsByNodeIds(nodeIds) {
      const out = new Map<string, FetchPrResult>();
      for (const id of nodeIds) {
        // Map node id via linear scan of stubs keyed by number suffix.
        let found: FetchPrResult | undefined;
        for (const [key, val] of byCoords) {
          if (val.ok && val.nodeId === id) {
            found = val;
            break;
          }
          void key;
        }
        out.set(
          id,
          found ?? { ok: false, error: `missing node ${id}` },
        );
      }
      return out;
    },
    async findOpenPrForHeadRef() {
      return { status: "none" };
    },
  };
}

describe("computeBackoffMs", () => {
  it("honors Retry-After up to the ceiling", () => {
    expect(computeBackoffMs(0, 5_000, () => 0)).toBe(5_000);
    expect(computeBackoffMs(0, GITHUB_BACKOFF_CEILING_MS * 2, () => 0)).toBe(
      GITHUB_BACKOFF_CEILING_MS,
    );
  });

  it("exponentially backs off with jitter and ceiling", () => {
    const noJitter = () => 0;
    expect(computeBackoffMs(0, undefined, noJitter)).toBe(GITHUB_POLL_HOT_MS);
    expect(computeBackoffMs(1, undefined, noJitter)).toBe(
      GITHUB_POLL_HOT_MS * 2,
    );
    expect(computeBackoffMs(10, undefined, noJitter)).toBe(
      GITHUB_BACKOFF_CEILING_MS,
    );
  });
});

describe("shouldReconcileForWakeGap", () => {
  it("treats startup (null last tick) as a gap", () => {
    expect(shouldReconcileForWakeGap(null, 1000, 30_000)).toBe(true);
  });

  it("detects gaps larger than two intervals", () => {
    expect(shouldReconcileForWakeGap(0, 60_001, 30_000)).toBe(true);
    expect(shouldReconcileForWakeGap(0, 59_999, 30_000)).toBe(false);
  });
});

describe("nextPollAtForClass", () => {
  it("uses hot 30s and warm 2min constants", () => {
    expect(nextPollAtForClass(0, "hot")).toBe(GITHUB_POLL_HOT_MS);
    expect(nextPollAtForClass(0, "warm")).toBe(GITHUB_POLL_WARM_MS);
  });
});

describe("reconcileTrackedResources (shadow)", () => {
  it("persists head-change events for multi-PR multi-run associations without wakes", async () => {
    const clock = fakeClock(10_000);
    const store = new InMemoryPipelineStore(clock);

    await store.createRun(makeProductRun({ id: "run-a", threadId: "Ta" }));
    await store.createRun(
      makeProductRun({
        id: "run-b",
        threadId: "Tb",
        status: "terminal",
        phase: "shipped",
      }),
    );
    // second active run in another thread
    await store.createRun(
      makeProductRun({ id: "run-c", threadId: "Tc", phase: "reviewing" }),
    );

    const resBackend = makeResource({
      id: "res-be",
      owner: "acme",
      repo: "backend",
      number: 1,
      nodeId: "PR_be",
      snapshot: snap({ headRefOid: "be-old", checkRollupSha: "be-old" }),
    });
    const resFrontend = makeResource({
      id: "res-fe",
      owner: "acme",
      repo: "frontend",
      number: 2,
      nodeId: "PR_fe",
      snapshot: snap({ headRefOid: "fe-old", checkRollupSha: "fe-old" }),
    });
    // Same-repo second PR
    const resBackendMain = makeResource({
      id: "res-be-main",
      owner: "acme",
      repo: "backend",
      number: 3,
      nodeId: "PR_be_main",
      snapshot: snap({ headRefOid: "bem-old", checkRollupSha: "bem-old" }),
    });

    for (const r of [resBackend, resFrontend, resBackendMain]) {
      await store.upsertGitHubResource(r);
    }

    // run-a tracks backend dev + frontend candidate
    await store.registerPipelineGitHubResource({
      id: "assoc-a-be",
      runId: "run-a",
      resourceId: "res-be",
      role: "dev-pr",
      workstreamKey: "backend",
      attemptId: "att-a",
      registeredByAssignmentId: null,
      expectedHeadSha: "be-old",
      active: true,
    });
    await store.registerPipelineGitHubResource({
      id: "assoc-a-fe",
      runId: "run-a",
      resourceId: "res-fe",
      role: "candidate",
      workstreamKey: "frontend",
      attemptId: "att-a",
      registeredByAssignmentId: null,
      expectedHeadSha: "fe-old",
      active: true,
    });
    // run-c also watches the same backend PR (multi-run association)
    await store.registerPipelineGitHubResource({
      id: "assoc-c-be",
      runId: "run-c",
      resourceId: "res-be",
      role: "review-target",
      workstreamKey: "backend",
      attemptId: "att-c",
      registeredByAssignmentId: null,
      expectedHeadSha: "be-old",
      active: true,
    });
    // same-repo main PR on run-a
    await store.registerPipelineGitHubResource({
      id: "assoc-a-bem",
      runId: "run-a",
      resourceId: "res-be-main",
      role: "main-pr",
      workstreamKey: "backend",
      attemptId: "att-a",
      registeredByAssignmentId: null,
      expectedHeadSha: "bem-old",
      active: true,
    });

    const client = fakeClient(
      new Map([
        [
          "acme/backend#1",
          {
            ok: true,
            nodeId: "PR_be",
            snapshot: snap({
              headRefOid: "be-new",
              checkRollupSha: "be-new",
              checkRollup: "SUCCESS",
            }),
          },
        ],
        [
          "acme/frontend#2",
          {
            ok: true,
            nodeId: "PR_fe",
            snapshot: snap({ headRefOid: "fe-old", checkRollupSha: "fe-old" }),
          },
        ],
        [
          "acme/backend#3",
          {
            ok: true,
            nodeId: "PR_be_main",
            snapshot: snap({
              headRefOid: "bem-old",
              checkRollupSha: "bem-old",
              state: "MERGED",
              mergedAt: "t-merge",
            }),
          },
        ],
      ]),
    );

    const pass = await reconcileTrackedResources({
      store,
      client,
      clock,
      forceAllActive: true,
      shadowMode: true,
      eventWakeEnabled: false,
      random: () => 0,
    });

    expect(pass.wakesDelivered).toBe(0);
    expect(pass.credentialsInvalid).toBe(false);
    expect(pass.updated).toBeGreaterThanOrEqual(1);

    const runAEvents = await store.listEvents("run-a");
    const runCEvents = await store.listEvents("run-c");
    const headEventsA = runAEvents.filter(
      (e) => e.eventType === "github.pr.head_changed",
    );
    const headEventsC = runCEvents.filter(
      (e) => e.eventType === "github.pr.head_changed",
    );
    expect(headEventsA.length).toBeGreaterThanOrEqual(1);
    expect(headEventsC.length).toBeGreaterThanOrEqual(1);

    // Multi-run association: both runs see the same resource head change.
    expect(
      headEventsA.some((e) => e.payload.resourceId === "res-be"),
    ).toBe(true);
    expect(
      headEventsC.some((e) => e.payload.resourceId === "res-be"),
    ).toBe(true);

    const mergeEvents = runAEvents.filter(
      (e) => e.eventType === "github.pr.merged",
    );
    expect(mergeEvents.some((e) => e.payload.resourceId === "res-be-main")).toBe(
      true,
    );

    // Head-change payloads include proposed gate invalidation (shadow only).
    const withReduction = headEventsA.find(
      (e) => e.payload.resourceId === "res-be",
    );
    const reductions = withReduction?.payload.proposedReductions as
      | Array<{ kind: string }>
      | undefined;
    expect(
      reductions?.some((r) => r.kind === "invalidate_aggregate_gates"),
    ).toBe(true);

    // No wake outbox records of any kind.
    expect(await store.listOutbox("run-a")).toEqual([]);
    expect(await store.listOutbox("run-c")).toEqual([]);

    // Snapshot updated
    const updated = await store.getGitHubResource("res-be");
    expect(updated?.snapshot?.headRefOid).toBe("be-new");

    // Associations still listed distinctly for multi-PR same run
    const assocs = await store.listPipelineGitHubResources("run-a", true);
    expect(assocs).toHaveLength(3);
    expect(new Set(assocs.map((a) => a.resourceId)).size).toBe(3);
  });

  it("backs off on rate limits without emitting events", async () => {
    const clock = fakeClock(1_000);
    const store = new InMemoryPipelineStore(clock);
    await store.createRun(makeProductRun());
    await store.upsertGitHubResource(makeResource({ nodeId: null }));
    await store.registerPipelineGitHubResource({
      id: "assoc-1",
      runId: "run-1",
      resourceId: "res-1",
      role: "candidate",
      workstreamKey: "backend",
      attemptId: null,
      registeredByAssignmentId: null,
      expectedHeadSha: null,
      active: true,
    });

    let rateLimitedCalls = 0;
    const client = fakeClient(
      new Map([
        [
          "acme/widgets#10",
          {
            ok: false,
            error: "rate limited",
            rateLimited: true,
            retryAfterMs: 8_000,
          },
        ],
      ]),
    );

    const pass = await reconcileTrackedResources({
      store,
      client,
      clock,
      forceAllActive: true,
      random: () => 0,
      onRateLimited: () => {
        rateLimitedCalls += 1;
      },
    });

    expect(pass.rateLimited).toBe(1);
    expect(pass.eventsEmitted).toBe(0);
    expect(pass.wakesDelivered).toBe(0);
    expect(rateLimitedCalls).toBe(1);

    const resource = await store.getGitHubResource("res-1");
    expect(resource?.consecutiveFailures).toBe(1);
    expect(resource?.nextPollAt).toBe(1_000 + 8_000);
    expect(await store.listEvents("run-1")).toEqual([]);
  });

  it("does not deliver wakes even if eventWakeEnabled is true in Phase 5 code", async () => {
    const clock = fakeClock(1_000);
    const store = new InMemoryPipelineStore(clock);
    await store.createRun(makeProductRun());
    await store.upsertGitHubResource(
      makeResource({
        snapshot: snap({ headRefOid: "a", checkRollupSha: "a" }),
      }),
    );
    await store.registerPipelineGitHubResource({
      id: "assoc-1",
      runId: "run-1",
      resourceId: "res-1",
      role: "dev-pr",
      workstreamKey: "backend",
      attemptId: "att-1",
      registeredByAssignmentId: null,
      expectedHeadSha: "a",
      active: true,
    });

    const client = fakeClient(
      new Map([
        [
          "acme/widgets#10",
          {
            ok: true,
            nodeId: "PR_10",
            snapshot: snap({ headRefOid: "b", checkRollupSha: "b" }),
          },
        ],
      ]),
    );

    const pass = await reconcileTrackedResources({
      store,
      client,
      clock,
      forceAllActive: true,
      // Misconfiguration attempt — Phase 5 still must not wake.
      shadowMode: false,
      eventWakeEnabled: true,
    });

    expect(pass.wakesDelivered).toBe(0);
    expect(await store.listOutbox("run-1")).toEqual([]);
    const events = await store.listEvents("run-1");
    expect(events.some((e) => e.eventType === "github.pr.head_changed")).toBe(
      true,
    );
    expect(
      events.every((e) => e.payload.wakesDelivered === false),
    ).toBe(true);
  });

  it("reconciles immediately on wake-gap detection", async () => {
    const clock = fakeClock(100_000);
    const store = new InMemoryPipelineStore(clock);
    await store.createRun(makeProductRun());
    // next_poll_at is in the future — only force/wake-gap should pick it up
    await store.upsertGitHubResource(
      makeResource({ nextPollAt: 200_000, snapshot: snap() }),
    );
    await store.registerPipelineGitHubResource({
      id: "assoc-1",
      runId: "run-1",
      resourceId: "res-1",
      role: "candidate",
      workstreamKey: "backend",
      attemptId: null,
      registeredByAssignmentId: null,
      expectedHeadSha: null,
      active: true,
    });

    const client = fakeClient(
      new Map([
        [
          "acme/widgets#10",
          {
            ok: true,
            nodeId: "PR_10",
            snapshot: snap({
              state: "MERGED",
              mergedAt: "while-asleep",
              headRefOid: "sha-old",
            }),
          },
        ],
      ]),
    );

    const pass = await reconcileTrackedResources({
      store,
      client,
      clock,
      lastTickAt: 0, // gap >> 2 * interval
      intervalMs: 30_000,
    });

    expect(pass.wakeGapDetected).toBe(true);
    expect(pass.examined).toBe(1);
    const events = await store.listEvents("run-1");
    expect(events.some((e) => e.eventType === "github.pr.merged")).toBe(true);
    expect(pass.wakesDelivered).toBe(0);
  });
});
