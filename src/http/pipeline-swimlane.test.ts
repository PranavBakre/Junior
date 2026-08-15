import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";

type LayoutHelpers = {
  sortLaneKeys: (names: string[]) => string[];
  swimlaneDomain: (
    run: { createdAt?: number },
    assignments: Array<{
      createdAt?: number;
      updatedAt?: number;
      leaseExpiresAt?: number | null;
    }>,
    now: number,
  ) => { start: number; end: number };
  assignmentBarRange: (
    assignment: { createdAt?: number; updatedAt?: number; status: string },
    now: number,
    fallback: number,
  ) => { x0: number; x1: number };
  assignmentBarColor: (status: string) => string;
  isUnleasedPending: (assignment: { status: string; leaseOwner: string | null }) => boolean;
  phaseTapeCells: (
    transitions: Array<{ toPhase?: string; occurredAt?: number }>,
    now: number,
    fallback: number,
  ) => Array<{ toPhase: string; start: number; end: number; duration: number }>;
  assignmentBlockerKinds: (
    assignment: { outcomes?: Array<{ blockers?: Array<{ kind?: string }> }> },
  ) => string[];
  groupAssignmentsByLane: (
    assignments: Array<{ targetAgent?: string; createdAt?: number }>,
  ) => Array<{ agent: string; assignments: Array<{ targetAgent?: string; createdAt?: number }> }>;
  domainPercent: (ts: number, domain: { start: number; end: number }) => number;
};

async function loadLayout(): Promise<LayoutHelpers> {
  const source = await Bun.file(
    resolve(import.meta.dirname, "../../public/js/pipeline-layout.js"),
  ).text();
  return new Function(`${source}; return {
    sortLaneKeys, swimlaneDomain, assignmentBarRange, assignmentBarColor,
    isUnleasedPending, phaseTapeCells, assignmentBlockerKinds,
    groupAssignmentsByLane, domainPercent,
  };`)() as LayoutHelpers;
}

describe("pipeline swimlane layout", () => {
  it("sorts lanes lead, default, then A–Z", async () => {
    const { sortLaneKeys } = await loadLayout();
    expect(sortLaneKeys(["review", "default", "build", "lead", "reproducer"]))
      .toEqual(["lead", "default", "build", "reproducer", "review"]);
  });

  it("uses createdAt min through max(updatedAt, lease, now) and falls back missing timestamps", async () => {
    const { swimlaneDomain } = await loadLayout();
    expect(swimlaneDomain(
      { createdAt: 1_000 },
      [
        { createdAt: 1_500, updatedAt: 2_000 },
        { createdAt: undefined, updatedAt: undefined, leaseExpiresAt: 4_000 },
      ],
      3_000,
    )).toEqual({ start: 1_000, end: 4_000 });
  });

  it("ends open bars at now and terminal bars at updatedAt", async () => {
    const { assignmentBarRange } = await loadLayout();
    expect(assignmentBarRange(
      { createdAt: 10, updatedAt: 20, status: "leased" },
      50,
      1,
    )).toEqual({ x0: 10, x1: 50 });
    expect(assignmentBarRange(
      { createdAt: 10, updatedAt: 20, status: "completed" },
      50,
      1,
    )).toEqual({ x0: 10, x1: 20 });
    expect(assignmentBarRange(
      { createdAt: 10, updatedAt: 20, status: "failed" },
      50,
      1,
    )).toEqual({ x0: 10, x1: 20 });
    expect(assignmentBarRange(
      { createdAt: 10, updatedAt: 20, status: "cancelled" },
      50,
      1,
    )).toEqual({ x0: 10, x1: 20 });
  });

  it("maps assignment colors and hollow unleased pending bars", async () => {
    const { assignmentBarColor, isUnleasedPending } = await loadLayout();
    expect(assignmentBarColor("leased")).toBe("#4f8cff");
    expect(assignmentBarColor("pending")).toBe("#4f8cff");
    expect(assignmentBarColor("waiting")).toBe("#f59e0b");
    expect(assignmentBarColor("needs-human")).toBe("#f59e0b");
    expect(assignmentBarColor("completed")).toBe("#22c55e");
    expect(assignmentBarColor("failed")).toBe("#ff3b3b");
    expect(assignmentBarColor("cancelled")).toBe("#666666");
    expect(isUnleasedPending({ status: "pending", leaseOwner: null })).toBe(true);
    expect(isUnleasedPending({ status: "pending", leaseOwner: "lead" })).toBe(false);
    expect(isUnleasedPending({ status: "leased", leaseOwner: null })).toBe(false);
  });

  it("builds one phase-tape cell per transition and stretches the last to now", async () => {
    const { phaseTapeCells } = await loadLayout();
    expect(phaseTapeCells(
      [
        { toPhase: "reviewing", occurredAt: 30 },
        { toPhase: "intake", occurredAt: 10 },
        { toPhase: "fixing", occurredAt: 20 },
      ],
      50,
      1,
    )).toEqual([
      { toPhase: "intake", start: 10, end: 20, duration: 10 },
      { toPhase: "fixing", start: 20, end: 30, duration: 10 },
      { toPhase: "reviewing", start: 30, end: 50, duration: 20 },
    ]);
  });

  it("groups stacked assignments by targetAgent and collects blocker kinds", async () => {
    const { groupAssignmentsByLane, assignmentBlockerKinds } = await loadLayout();
    const lanes = groupAssignmentsByLane([
      { targetAgent: "review", createdAt: 2 },
      { targetAgent: "lead", createdAt: 3 },
      { targetAgent: "lead", createdAt: 1 },
    ]);
    expect(lanes.map((lane) => [lane.agent, lane.assignments.map((item) => item.createdAt)]))
      .toEqual([
        ["lead", [1, 3]],
        ["review", [2]],
      ]);
    expect(assignmentBlockerKinds({
      outcomes: [
        { blockers: [{ kind: "human_gate" }, { kind: "infra_failure" }] },
        { blockers: [{ kind: "human_gate" }] },
      ],
    })).toEqual(["human_gate", "infra_failure"]);
  });
});

describe("pipeline swimlane markup", () => {
  it("defaults to swimlane and keeps topology as a toggle", async () => {
    const html = await Bun.file(
      resolve(import.meta.dirname, "../../public/index.html"),
    ).text();
    expect(html).toContain('id="pipeline-swimlane"');
    expect(html).toContain('id="pipeline-mode-topology"');
    expect(html).toContain("pipeline-layout.js");
    const js = await Bun.file(
      resolve(import.meta.dirname, "../../public/js/pipelines.js"),
    ).text();
    expect(js).toContain('pipelineViewMode = "swimlane"');
    expect(js).toContain("No typed pipeline runs. Default-kind durability is hidden unless you enable it.");
    expect(js).toContain("Pipeline controllers are off.");
    expect(js).toContain("Failed to load run.");
    expect(js).not.toContain("agent chat");
    expect(js).toContain("renderAssignmentRail");
  });
});
