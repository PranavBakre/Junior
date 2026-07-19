import { describe, expect, it } from "bun:test";
import {
  diffPrSnapshots,
  proposeReductionsForEvents,
} from "./diff.ts";
import type { PrSnapshot } from "./types.ts";

function snap(overrides: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    headRefName: "feat/x",
    headRefOid: "aaa111",
    reviewDecision: null,
    mergeable: "MERGEABLE",
    mergedAt: null,
    closedAt: null,
    checkRollup: "PENDING",
    checkRollupSha: "aaa111",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const ctx = {
  resourceId: "res-1",
  owner: "acme",
  repo: "widgets",
  number: 42,
  observedAt: 1_000,
};

describe("diffPrSnapshots", () => {
  it("emits no events on first observation", () => {
    expect(diffPrSnapshots(null, snap(), ctx)).toEqual([]);
  });

  it("emits head_changed when head SHA changes", () => {
    const events = diffPrSnapshots(
      snap({ headRefOid: "aaa111" }),
      snap({ headRefOid: "bbb222", checkRollupSha: "bbb222" }),
      ctx,
    );
    expect(events.map((e) => e.type)).toContain("github.pr.head_changed");
    const head = events.find((e) => e.type === "github.pr.head_changed");
    expect(head?.previous?.headRefOid).toBe("aaa111");
    expect(head?.next.headRefOid).toBe("bbb222");
  });

  it("emits base_changed", () => {
    const events = diffPrSnapshots(
      snap({ baseRefName: "main" }),
      snap({ baseRefName: "develop" }),
      ctx,
    );
    expect(events.map((e) => e.type)).toEqual(["github.pr.base_changed"]);
  });

  it("emits review_decision_changed", () => {
    const events = diffPrSnapshots(
      snap({ reviewDecision: null }),
      snap({ reviewDecision: "APPROVED" }),
      ctx,
    );
    expect(events.map((e) => e.type)).toEqual([
      "github.pr.review_decision_changed",
    ]);
  });

  it("emits checks_changed independently of head", () => {
    const events = diffPrSnapshots(
      snap({ checkRollup: "PENDING", checkRollupSha: "aaa111" }),
      snap({ checkRollup: "SUCCESS", checkRollupSha: "aaa111" }),
      ctx,
    );
    expect(events.map((e) => e.type)).toEqual(["github.pr.checks_changed"]);
  });

  it("emits closed for open→closed", () => {
    const events = diffPrSnapshots(
      snap({ state: "OPEN" }),
      snap({ state: "CLOSED", closedAt: "2026-01-02T00:00:00Z" }),
      ctx,
    );
    expect(events.map((e) => e.type)).toEqual(["github.pr.closed"]);
  });

  it("emits merged (distinct from closed)", () => {
    const events = diffPrSnapshots(
      snap({ state: "OPEN" }),
      snap({
        state: "MERGED",
        mergedAt: "2026-01-02T00:00:00Z",
        closedAt: "2026-01-02T00:00:00Z",
      }),
      ctx,
    );
    expect(events.map((e) => e.type)).toEqual(["github.pr.merged"]);
  });

  it("emits reopened for closed→open", () => {
    const events = diffPrSnapshots(
      snap({ state: "CLOSED", closedAt: "2026-01-02T00:00:00Z" }),
      snap({ state: "OPEN", closedAt: null }),
      ctx,
    );
    expect(events.map((e) => e.type)).toEqual(["github.pr.reopened"]);
  });

  it("emits multiple events when several fields change", () => {
    const events = diffPrSnapshots(
      snap({
        headRefOid: "aaa",
        reviewDecision: null,
        checkRollup: "PENDING",
      }),
      snap({
        headRefOid: "bbb",
        checkRollupSha: "bbb",
        reviewDecision: "CHANGES_REQUESTED",
        checkRollup: "FAILURE",
      }),
      ctx,
    );
    expect(new Set(events.map((e) => e.type))).toEqual(
      new Set([
        "github.pr.checks_changed",
        "github.pr.head_changed",
        "github.pr.review_decision_changed",
      ] as const),
    );
  });
});

describe("proposeReductionsForEvents", () => {
  it("proposes gate invalidation per active association on head change", () => {
    const events = diffPrSnapshots(
      snap({ headRefOid: "old" }),
      snap({ headRefOid: "new", checkRollupSha: "new" }),
      ctx,
    );
    const reductions = proposeReductionsForEvents(events, [
      {
        resourceId: "res-1",
        role: "dev-pr",
        workstreamKey: "backend",
        attemptId: "att-1",
        active: true,
      },
      {
        resourceId: "res-1",
        role: "main-pr",
        workstreamKey: "frontend",
        attemptId: "att-2",
        active: true,
      },
      {
        resourceId: "res-1",
        role: "dependency",
        workstreamKey: "dead",
        attemptId: null,
        active: false,
      },
    ]);
    const invalidations = reductions.filter(
      (r) => r.kind === "invalidate_aggregate_gates",
    );
    expect(invalidations).toHaveLength(2);
    expect(invalidations.map((r) => r.workstreamKey).sort()).toEqual([
      "backend",
      "frontend",
    ]);
    expect(
      invalidations.every(
        (r) =>
          r.kind === "invalidate_aggregate_gates" &&
          r.previousHeadSha === "old" &&
          r.nextHeadSha === "new",
      ),
    ).toBe(true);
  });

  it("proposes role_specific_merge on merge events", () => {
    const events = diffPrSnapshots(
      snap({ state: "OPEN" }),
      snap({ state: "MERGED", mergedAt: "t", headRefOid: "sha" }),
      ctx,
    );
    const reductions = proposeReductionsForEvents(events, [
      {
        resourceId: "res-1",
        role: "dev-pr",
        workstreamKey: "backend",
        attemptId: "att-1",
        active: true,
      },
      {
        resourceId: "res-1",
        role: "main-pr",
        workstreamKey: "backend",
        attemptId: "att-1",
        active: true,
      },
    ]);
    const merges = reductions.filter((r) => r.kind === "role_specific_merge");
    expect(merges).toHaveLength(2);
    expect(merges.map((r) => (r.kind === "role_specific_merge" ? r.role : "")))
      .toEqual(["dev-pr", "main-pr"]);
  });
});
