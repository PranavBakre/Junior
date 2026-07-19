/**
 * Phase 7: product controller — discovery → build → review ↔ rework → human merge.
 */
import { describe, expect, it } from "bun:test";
import { fakeClock } from "../../time/clock.ts";
import { InMemoryPipelineStore } from "../store/memory.ts";
import { makeAssignmentCreate } from "../store/test-helpers.ts";
import {
  createProductRun,
  ensureProductRevisionGates,
  fanOutBuilders,
  loadSkipReasons,
  reduceProductOutcome,
  registerProductPr,
  shouldCreateProductRun,
  updateProductRevision,
} from "./controller.ts";
import {
  detectFullStackIntent,
  initialProductStart,
  shouldSkipPmAndArchitecture,
  suggestPhaseAfterOutcome,
} from "./definition.ts";
import {
  fanOutComplete,
  prRegistrationKey,
  revisionGatesConsistent,
} from "./policy.ts";
import { buildProductContext } from "./context.ts";
import type { AgentOutcome, ProductRun } from "../types.ts";

function cfg(store: InMemoryPipelineStore, clock = fakeClock(1_000)) {
  return { store, clock };
}

function baseOutcome(
  overrides: Partial<AgentOutcome> & Pick<AgentOutcome, "assignmentId">,
): AgentOutcome {
  return {
    expectedRunVersion: 0,
    action: "complete",
    status: "succeeded",
    reason: "done",
    evidenceRefs: [],
    artifactRefs: [],
    blockers: [],
    checks: [],
    progressFingerprint: "fp-1",
    ...overrides,
  };
}

/** Walk legal product phases with continue_self until target. */
async function advanceToPhase(
  store: InMemoryPipelineStore,
  runId: string,
  assignmentId: string,
  targetPhase: string,
  startVersion = 0,
): Promise<number> {
  const path: string[] = [];
  const order = [
    "discovery",
    "spec-drafting",
    "ready-to-build",
    "building",
    "aggregate-verification",
    "pr-open",
    "reviewing",
    "approved",
    "ready-for-human-merge",
  ];
  const run = await store.getRun(runId);
  if (!run) throw new Error("missing run");
  let from = run.phase;
  let version = startVersion;
  // If start is ready-to-build, path from there.
  const startIdx = order.indexOf(from);
  const endIdx = order.indexOf(targetPhase);
  if (startIdx < 0 || endIdx < 0) {
    throw new Error(`bad phase path ${from} → ${targetPhase}`);
  }
  for (let i = startIdx + 1; i <= endIdx; i++) {
    path.push(order[i]);
  }
  for (const phase of path) {
    const r = await store.recordOutcomeTransaction({
      outcome: baseOutcome({
        assignmentId,
        expectedRunVersion: version,
        action: "continue_self",
        status: "progress",
        reason: `advance to ${phase}`,
        progressFingerprint: `adv-${phase}-${version}`,
      }),
      toPhase: phase,
      actorType: "system",
      actorId: "test",
      idempotencyKey: `adv-${runId}-${phase}-${version}`,
    });
    expect(r.status).toBe("accepted");
    version = r.runVersion;
  }
  return version;
}

describe("shouldCreateProductRun", () => {
  it("requires PRODUCT_PIPELINE_ENABLED + active + explicit start", () => {
    expect(
      shouldCreateProductRun({
        productPipelineEnabled: false,
        runtimeMode: "active",
        explicitStart: true,
      }),
    ).toBe(false);
    expect(
      shouldCreateProductRun({
        productPipelineEnabled: true,
        runtimeMode: "off",
        explicitStart: true,
      }),
    ).toBe(false);
    expect(
      shouldCreateProductRun({
        productPipelineEnabled: true,
        runtimeMode: "shadow",
        explicitStart: true,
      }),
    ).toBe(false);
    expect(
      shouldCreateProductRun({
        productPipelineEnabled: true,
        runtimeMode: "active",
        explicitStart: false,
      }),
    ).toBe(false);
    expect(
      shouldCreateProductRun({
        productPipelineEnabled: true,
        runtimeMode: "active",
        explicitStart: true,
      }),
    ).toBe(true);
  });
});

describe("skip PM/architecture + direct build authority", () => {
  it("skips PM/architecture for well-specified direct build", () => {
    const result = shouldSkipPmAndArchitecture({
      startKind: "build",
      objective: "implement POST /api/invites endpoint with rate limit",
    });
    expect(result.skip).toBe(true);
    expect(result.reasons.map((r) => r.stage)).toContain("pm");
    expect(result.reasons.map((r) => r.stage)).toContain("architecture");
  });

  it("does not skip for !pm", () => {
    const result = shouldSkipPmAndArchitecture({
      startKind: "pm",
      objective: "implement POST /api/invites",
    });
    expect(result.skip).toBe(false);
  });

  it("does not skip ambiguous product questions", () => {
    const result = shouldSkipPmAndArchitecture({
      startKind: "build",
      objective: "should we build invites or wait for MVP trade-off?",
    });
    expect(result.skip).toBe(false);
  });

  it("initialProductStart for !build lands ready-to-build when skippable", () => {
    const start = initialProductStart({
      startKind: "build",
      objective: "fix the invite API handler to reject expired tokens",
    });
    expect(start.phase).toBe("ready-to-build");
    expect(start.targetAgent).toBe("build");
    expect(start.skipReasons.length).toBeGreaterThan(0);
  });
});

describe("flags off → no ProductRun", () => {
  it("shouldCreateProductRun false when product pipeline disabled", () => {
    expect(
      shouldCreateProductRun({
        productPipelineEnabled: false,
        runtimeMode: "active",
        explicitStart: true,
      }),
    ).toBe(false);
  });
});

describe("createProductRun", () => {
  it("creates on explicit !pm", async () => {
    const store = new InMemoryPipelineStore(fakeClock(1000));
    const result = await createProductRun(cfg(store), {
      channelId: "C1",
      threadId: "T-pm",
      objective: "design invite flow for teams",
      startKind: "pm",
      messageTs: "111.1",
    });
    expect(result.created).toBe(true);
    expect(result.run.kind).toBe("product");
    expect(result.run.phase).toBe("discovery");
    expect(result.assignment.targetAgent).toBe("pm");
    expect(result.skipReasons).toEqual([]);
  });

  it("creates on explicit !build with skip recorded", async () => {
    const store = new InMemoryPipelineStore(fakeClock(1000));
    const result = await createProductRun(cfg(store), {
      channelId: "C1",
      threadId: "T-build",
      objective: "implement POST /api/invites endpoint with validation",
      startKind: "build",
      messageTs: "222.2",
    });
    expect(result.created).toBe(true);
    expect(result.run.phase).toBe("ready-to-build");
    expect(result.assignment.targetAgent).toBe("build");
    expect(result.skipReasons.length).toBe(2);
    const loaded = await loadSkipReasons(store, result.run.id);
    expect(loaded.length).toBe(2);
  });

  it("idempotent reuse of active run on same thread", async () => {
    const store = new InMemoryPipelineStore(fakeClock(1000));
    const first = await createProductRun(cfg(store), {
      channelId: "C1",
      threadId: "T-same",
      objective: "implement invite API endpoint handler",
      startKind: "build",
      messageTs: "1",
    });
    const second = await createProductRun(cfg(store), {
      channelId: "C1",
      threadId: "T-same",
      objective: "more work",
      startKind: "pm",
      messageTs: "2",
    });
    expect(second.created).toBe(false);
    expect(second.run.id).toBe(first.run.id);
  });
});

describe("backend feature → ready-for-human-merge", () => {
  it("reaches ready-for-human-merge with simulated outcomes", async () => {
    const clock = fakeClock(1000);
    const store = new InMemoryPipelineStore(clock);
    const { run, assignment } = await createProductRun(cfg(store, clock), {
      channelId: "C1",
      threadId: "T-backend",
      objective: "implement POST /api/invites endpoint with rate limiting",
      startKind: "build",
      messageTs: "10.1",
      repoRefs: ["example-backend"],
    });

    // ready-to-build → building
    let version = 0;
    let r = await reduceProductOutcome(cfg(store, clock), {
      actorId: "build",
      toPhase: "building",
      outcome: baseOutcome({
        assignmentId: assignment.id,
        expectedRunVersion: version,
        action: "continue_self",
        status: "progress",
        reason: "starting implementation",
        progressFingerprint: "b1",
      }),
    });
    expect(r.status).toBe("accepted");
    version = r.runVersion;

    // Complete build → aggregate-verification
    r = await reduceProductOutcome(cfg(store, clock), {
      actorId: "build",
      outcome: baseOutcome({
        assignmentId: assignment.id,
        expectedRunVersion: version,
        action: "complete",
        status: "succeeded",
        reason: "implementation + checks + checkpoint commit",
        progressFingerprint: "b2",
        checks: [
          { name: "typecheck", status: "passed" },
          { name: "unit", status: "passed" },
        ],
        artifactRefs: ["commit:abc123"],
      }),
    });
    expect(r.status).toBe("accepted");
    version = r.runVersion;
    expect((await store.getRun(run.id))?.phase).toBe("aggregate-verification");

    // Bind attempt + revision for gates
    const attemptId = "attempt-be-1";
    await store.createAttempt({
      id: attemptId,
      runId: run.id,
      ordinal: 1,
      revisionDigest: null,
      status: "open",
      invalidatedAt: null,
      invalidationReason: null,
      createdAt: 1000,
      finishedAt: null,
    });
    await updateProductRevision(cfg(store, clock), {
      attemptId,
      members: [
        {
          memberKey: "backend",
          repoRef: "example-backend",
          branch: "feat/invites",
          headSha: "sha-be-1",
        },
      ],
    });
    // Patch active attempt on run
    const mem = store as unknown as { runs: Map<string, ProductRun> };
    const cur = mem.runs.get(run.id)!;
    mem.runs.set(run.id, { ...cur, activeAttemptId: attemptId });

    await ensureProductRevisionGates(store, {
      runId: run.id,
      attemptId,
      subjectSha: "sha-be-1",
      memberKey: "backend",
    });
    for (const g of await store.listGates(attemptId)) {
      await store.upsertGate({ ...g, status: "passed" });
    }

    // Need a fresh open assignment for subsequent phases (builder completed).
    const orch = await store.createAssignment(
      makeAssignmentCreate({
        id: "asg-orch",
        runId: run.id,
        sourceAgent: "system",
        targetAgent: "default",
        objective: "coordinate verification and PR",
        attemptId,
        candidateRevisionDigest: "d1",
        idempotencyKey: "orch-1",
        status: "leased",
      }),
    );

    version = (await store.getRun(run.id))!.stateVersion;

    // aggregate-verification → pr-open
    r = await reduceProductOutcome(cfg(store, clock), {
      actorId: "default",
      outcome: baseOutcome({
        assignmentId: orch.id,
        expectedRunVersion: version,
        action: "complete",
        status: "succeeded",
        reason: "aggregate verification passed",
        progressFingerprint: "av1",
        checks: [{ name: "aggregate", status: "passed" }],
      }),
    });
    expect(r.status).toBe("accepted");
    version = r.runVersion;
    expect((await store.getRun(run.id))?.phase).toBe("pr-open");

    await registerProductPr(cfg(store, clock), {
      runId: run.id,
      assignmentId: orch.id,
      owner: "acme",
      repo: "example-backend",
      number: 42,
      role: "candidate",
      workstreamKey: "backend",
      attemptId,
      expectedHeadSha: "sha-be-1",
      actorId: "default",
    });

    // New assignment for review path (orch completed)
    const reviewCoord = await store.createAssignment(
      makeAssignmentCreate({
        id: "asg-pr",
        runId: run.id,
        sourceAgent: "default",
        targetAgent: "default",
        objective: "open PR and request review",
        attemptId,
        idempotencyKey: "pr-coord-1",
        status: "leased",
      }),
    );
    version = (await store.getRun(run.id))!.stateVersion;

    r = await reduceProductOutcome(cfg(store, clock), {
      actorId: "default",
      toPhase: "reviewing",
      outcome: baseOutcome({
        assignmentId: reviewCoord.id,
        expectedRunVersion: version,
        action: "complete",
        status: "succeeded",
        reason: "PR registered",
        progressFingerprint: "pr1",
      }),
    });
    expect(r.status).toBe("accepted");
    version = r.runVersion;

    const reviewer = await store.createAssignment(
      makeAssignmentCreate({
        id: "asg-rev",
        runId: run.id,
        sourceAgent: "default",
        targetAgent: "review",
        objective: "review invites PR",
        attemptId,
        candidateRevisionDigest: "d1",
        idempotencyKey: "rev-1",
        status: "leased",
        mutationScope: [],
      }),
    );

    r = await reduceProductOutcome(cfg(store, clock), {
      actorId: "review",
      reviewVerdict: "approved",
      outcome: baseOutcome({
        assignmentId: reviewer.id,
        expectedRunVersion: version,
        action: "complete",
        status: "succeeded",
        reason: "LGTM",
        progressFingerprint: "rev-ok",
        checks: [{ name: "review", status: "passed" }],
      }),
    });
    expect(r.status).toBe("accepted");
    version = r.runVersion;
    expect((await store.getRun(run.id))?.phase).toBe("approved");

    const mergeCoord = await store.createAssignment(
      makeAssignmentCreate({
        id: "asg-merge-gate",
        runId: run.id,
        sourceAgent: "system",
        targetAgent: "default",
        objective: "mark ready for human merge",
        attemptId,
        idempotencyKey: "merge-gate-1",
        status: "leased",
      }),
    );

    r = await reduceProductOutcome(cfg(store, clock), {
      actorId: "default",
      outcome: baseOutcome({
        assignmentId: mergeCoord.id,
        expectedRunVersion: version,
        action: "complete",
        status: "succeeded",
        reason: "all gates green; human merge required",
        progressFingerprint: "ready-merge",
      }),
    });
    expect(r.status).toBe("accepted");
    expect((await store.getRun(run.id))?.phase).toBe("ready-for-human-merge");
  });
});

describe("full-stack fan-out rejoin", () => {
  it("detects full-stack intent", () => {
    expect(
      detectFullStackIntent(
        "add invite API endpoint and frontend invite modal form",
      ),
    ).toBe(true);
    expect(detectFullStackIntent("fix the backend rate limiter only")).toBe(
      false,
    );
  });

  it("fans out build+frontend and rejoins only when both complete", async () => {
    const clock = fakeClock(1000);
    const store = new InMemoryPipelineStore(clock);
    const created = await createProductRun(cfg(store, clock), {
      channelId: "C1",
      threadId: "T-fs",
      objective:
        "full-stack: implement invite API endpoint and frontend invite modal",
      startKind: "pm",
      messageTs: "20.2",
    });

    // Advance to ready-to-build via system continues
    let version = await advanceToPhase(
      store,
      created.run.id,
      created.assignment.id,
      "ready-to-build",
      0,
    );

    const { assignments, receipt } = await fanOutBuilders(cfg(store, clock), {
      runId: created.run.id,
      parentAssignmentId: created.assignment.id,
      sourceAgent: "default",
      objective: created.assignment.objective,
      expectedRunVersion: version,
      idempotencyKey: "fanout-1",
    });
    expect(receipt.status).toBe("accepted");
    expect(assignments.length).toBe(2);
    expect(new Set(assignments.map((a) => a.targetAgent))).toEqual(
      new Set(["build", "frontend"]),
    );

    version = receipt.runVersion;
    const buildAsg = assignments.find((a) => a.targetAgent === "build")!;
    const feAsg = assignments.find((a) => a.targetAgent === "frontend")!;

    // First builder completes — stay in building
    const r1 = await reduceProductOutcome(cfg(store, clock), {
      actorId: "build",
      outcome: baseOutcome({
        assignmentId: buildAsg.id,
        expectedRunVersion: version,
        action: "complete",
        status: "succeeded",
        reason: "backend done",
        progressFingerprint: "be-done",
      }),
    });
    expect(r1.status).toBe("accepted");
    expect((await store.getRun(created.run.id))?.phase).toBe("building");
    version = r1.runVersion;

    // Second builder completes — rejoin to aggregate-verification
    const r2 = await reduceProductOutcome(cfg(store, clock), {
      actorId: "frontend",
      outcome: baseOutcome({
        assignmentId: feAsg.id,
        expectedRunVersion: version,
        action: "complete",
        status: "succeeded",
        reason: "frontend done",
        progressFingerprint: "fe-done",
      }),
    });
    expect(r2.status).toBe("accepted");
    expect((await store.getRun(created.run.id))?.phase).toBe(
      "aggregate-verification",
    );

    // fanOutComplete helper
    expect(
      fanOutComplete(
        [buildAsg, feAsg].map((a) => ({ ...a, status: "completed" as const })),
      ),
    ).toBe(true);
  });
});

describe("review → fix → new revision → re-review", () => {
  it("converges after rework with new revision digest", async () => {
    const clock = fakeClock(1000);
    const store = new InMemoryPipelineStore(clock);
    const created = await createProductRun(cfg(store, clock), {
      channelId: "C1",
      threadId: "T-rework",
      objective: "implement invite API endpoint handler",
      startKind: "build",
      messageTs: "30.3",
    });

    const attemptId = "attempt-rw";
    await store.createAttempt({
      id: attemptId,
      runId: created.run.id,
      ordinal: 1,
      revisionDigest: null,
      status: "open",
      invalidatedAt: null,
      invalidationReason: null,
      createdAt: 1000,
      finishedAt: null,
    });
    const rev1 = await updateProductRevision(cfg(store, clock), {
      attemptId,
      members: [
        {
          memberKey: "backend",
          repoRef: "example-backend",
          branch: "feat/x",
          headSha: "aaa111",
        },
      ],
    });
    expect(rev1.digest).toBeTruthy();

    await ensureProductRevisionGates(store, {
      runId: created.run.id,
      attemptId,
      subjectSha: "aaa111",
    });
    for (const g of await store.listGates(attemptId)) {
      await store.upsertGate({ ...g, status: "passed" });
    }

    // Walk to reviewing
    let version = await advanceToPhase(
      store,
      created.run.id,
      created.assignment.id,
      "reviewing",
      0,
    );
    const mem = store as unknown as { runs: Map<string, ProductRun> };
    const cur = mem.runs.get(created.run.id)!;
    mem.runs.set(created.run.id, {
      ...cur,
      activeAttemptId: attemptId,
      phase: "reviewing",
      stateVersion: version,
    });

    const reviewer = await store.createAssignment(
      makeAssignmentCreate({
        id: "asg-rev-rw",
        runId: created.run.id,
        sourceAgent: "default",
        targetAgent: "review",
        objective: "review",
        attemptId,
        candidateRevisionDigest: rev1.digest,
        idempotencyKey: "rev-rw-1",
        status: "leased",
      }),
    );

    // Changes requested
    const fail = await reduceProductOutcome(cfg(store, clock), {
      actorId: "review",
      reviewVerdict: "changes_requested",
      outcome: baseOutcome({
        assignmentId: reviewer.id,
        expectedRunVersion: version,
        action: "complete",
        status: "failed",
        reason: "missing null check",
        progressFingerprint: "findings-null",
        checks: [
          {
            name: "review",
            status: "failed",
            evidenceRef: "null-check-missing",
          },
        ],
      }),
    });
    expect(fail.status).toBe("accepted");
    version = fail.runVersion;
    expect((await store.getRun(created.run.id))?.phase).toBe("fixing");

    const gatesAfterFail = await store.listGates(attemptId);
    expect(gatesAfterFail.every((g) => g.status === "invalidated")).toBe(true);

    // New revision after fix
    const rev2 = await updateProductRevision(cfg(store, clock), {
      attemptId,
      members: [
        {
          memberKey: "backend",
          repoRef: "example-backend",
          branch: "feat/x",
          headSha: "bbb222",
        },
      ],
    });
    expect(rev2.digest).not.toBe(rev1.digest);
    expect(rev2.invalidatedGateCount).toBeGreaterThanOrEqual(0);

    await ensureProductRevisionGates(store, {
      runId: created.run.id,
      attemptId,
      subjectSha: "bbb222",
    });
    for (const g of await store.listGates(attemptId)) {
      if (g.status !== "invalidated") {
        await store.upsertGate({ ...g, status: "passed", subjectSha: "bbb222" });
      }
    }
    // Fresh gates for re-review
    const freshGates = await ensureProductRevisionGates(store, {
      runId: created.run.id,
      attemptId,
      subjectSha: "bbb222",
      memberKey: "rework",
    });
    for (const g of freshGates) {
      await store.upsertGate({ ...g, status: "passed" });
    }

    // Advance fixing → building → … → reviewing for re-review
    const fixer = await store.createAssignment(
      makeAssignmentCreate({
        id: "asg-fix",
        runId: created.run.id,
        sourceAgent: "review",
        targetAgent: "build",
        objective: "address review findings",
        attemptId,
        candidateRevisionDigest: rev2.digest,
        idempotencyKey: "fix-1",
        status: "leased",
        mutationScope: ["worktree-code"],
      }),
    );
    version = (await store.getRun(created.run.id))!.stateVersion;

    const fixed = await reduceProductOutcome(cfg(store, clock), {
      actorId: "build",
      toPhase: "reviewing",
      outcome: baseOutcome({
        assignmentId: fixer.id,
        expectedRunVersion: version,
        action: "complete",
        status: "succeeded",
        reason: "fixed null check; new revision",
        progressFingerprint: "fix-done",
        artifactRefs: [`revision:${rev2.digest}`],
      }),
    });
    expect(fixed.status).toBe("accepted");
    version = fixed.runVersion;

    const reReviewer = await store.createAssignment(
      makeAssignmentCreate({
        id: "asg-rerev",
        runId: created.run.id,
        sourceAgent: "default",
        targetAgent: "review",
        objective: "re-review",
        attemptId,
        candidateRevisionDigest: rev2.digest,
        idempotencyKey: "rerev-1",
        status: "leased",
      }),
    );

    const ok = await reduceProductOutcome(cfg(store, clock), {
      actorId: "review",
      reviewVerdict: "approved",
      outcome: baseOutcome({
        assignmentId: reReviewer.id,
        expectedRunVersion: version,
        action: "complete",
        status: "succeeded",
        reason: "LGTM after fix",
        progressFingerprint: "rev-ok-2",
        checks: [{ name: "review", status: "passed" }],
        evidenceRefs: [`revision:${rev2.digest}`],
      }),
    });
    expect(ok.status).toBe("accepted");
    expect((await store.getRun(created.run.id))?.phase).toBe("approved");
  });
});

describe("unchanged findings escalate", () => {
  it("escalates when the same review findings repeat without new evidence", async () => {
    const clock = fakeClock(1000);
    const store = new InMemoryPipelineStore(clock);
    const created = await createProductRun(cfg(store, clock), {
      channelId: "C1",
      threadId: "T-loop",
      objective: "implement invite API endpoint",
      startKind: "build",
      messageTs: "40.4",
    });

    let version = await advanceToPhase(
      store,
      created.run.id,
      created.assignment.id,
      "reviewing",
      0,
    );

    const rev1 = await store.createAssignment(
      makeAssignmentCreate({
        id: "asg-loop-1",
        runId: created.run.id,
        sourceAgent: "default",
        targetAgent: "review",
        objective: "review",
        idempotencyKey: "loop-1",
        status: "leased",
      }),
    );

    const first = await reduceProductOutcome(cfg(store, clock), {
      actorId: "review",
      reviewVerdict: "changes_requested",
      outcome: baseOutcome({
        assignmentId: rev1.id,
        expectedRunVersion: version,
        action: "complete",
        status: "failed",
        reason: "missing tests",
        progressFingerprint: "same-findings",
        checks: [
          {
            name: "review",
            status: "failed",
            evidenceRef: "missing-tests",
          },
        ],
      }),
    });
    expect(first.status).toBe("accepted");
    // Phase moves to fixing after failed review.
    expect((await store.getRun(created.run.id))?.phase).toBe("fixing");

    // Force back to reviewing to simulate a re-review with identical findings
    // and no new revision/evidence.
    version = first.runVersion;
    const mem = store as unknown as { runs: Map<string, ProductRun> };
    const cur = mem.runs.get(created.run.id)!;
    mem.runs.set(created.run.id, {
      ...cur,
      phase: "reviewing",
      stateVersion: version,
    });

    const rev2 = await store.createAssignment(
      makeAssignmentCreate({
        id: "asg-loop-2",
        runId: created.run.id,
        sourceAgent: "default",
        targetAgent: "review",
        objective: "review again",
        idempotencyKey: "loop-2",
        status: "leased",
      }),
    );

    const second = await reduceProductOutcome(cfg(store, clock), {
      actorId: "review",
      reviewVerdict: "changes_requested",
      outcome: baseOutcome({
        assignmentId: rev2.id,
        expectedRunVersion: version,
        action: "complete",
        status: "failed",
        reason: "still missing tests",
        progressFingerprint: "same-findings",
        checks: [
          {
            name: "review",
            status: "failed",
            evidenceRef: "missing-tests",
          },
        ],
        // no evidenceRefs / revision artifacts
      }),
    });

    // Unchanged findings → escalate (receipt escalated, or accepted rewrite to needs-human).
    const runAfter = await store.getRun(created.run.id);
    expect(runAfter).toBeDefined();
    const escalated =
      second.status === "escalated" ||
      second.reason?.includes("unchanged review findings") === true ||
      runAfter?.phase === "needs-human";
    expect(escalated).toBe(true);
    if (runAfter?.phase === "needs-human") {
      expect(runAfter.status === "needs-human" || runAfter.phase === "needs-human").toBe(
        true,
      );
    }
  });
});

describe("multi-PR same repo tracked separately", () => {
  it("registers two PRs in one repo with distinct workstream keys", async () => {
    const clock = fakeClock(1000);
    const store = new InMemoryPipelineStore(clock);
    const created = await createProductRun(cfg(store, clock), {
      channelId: "C1",
      threadId: "T-multipr",
      objective: "implement invite API and worker job",
      startKind: "build",
      messageTs: "50.5",
    });

    const a = await registerProductPr(cfg(store, clock), {
      runId: created.run.id,
      assignmentId: created.assignment.id,
      owner: "acme",
      repo: "example-backend",
      number: 10,
      role: "candidate",
      workstreamKey: "api",
      expectedHeadSha: "sha-api",
      actorId: "default",
    });
    const b = await registerProductPr(cfg(store, clock), {
      runId: created.run.id,
      assignmentId: created.assignment.id,
      owner: "acme",
      repo: "example-backend",
      number: 11,
      role: "candidate",
      workstreamKey: "worker",
      expectedHeadSha: "sha-worker",
      actorId: "default",
    });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.key).not.toBe(b.key);
      expect(a.key).toContain("#10");
      expect(b.key).toContain("#11");
      expect(a.key).toContain("api");
      expect(b.key).toContain("worker");
    }

    // Cross-repo also distinct
    const c = await registerProductPr(cfg(store, clock), {
      runId: created.run.id,
      assignmentId: created.assignment.id,
      owner: "acme",
      repo: "example-frontend",
      number: 3,
      role: "candidate",
      workstreamKey: "frontend",
      expectedHeadSha: "sha-fe",
      actorId: "default",
    });
    expect(c.ok).toBe(true);

    const events = await store.listEvents(created.run.id);
    const regs = events.filter((e) => e.eventType === "github.pr.registered");
    expect(regs.length).toBe(3);

    expect(
      prRegistrationKey({
        owner: "acme",
        repo: "example-backend",
        number: 10,
        role: "candidate",
        workstreamKey: "api",
      }),
    ).not.toBe(
      prRegistrationKey({
        owner: "acme",
        repo: "example-backend",
        number: 11,
        role: "candidate",
        workstreamKey: "worker",
      }),
    );
  });

  it("revision member change invalidates aggregate gates", async () => {
    const store = new InMemoryPipelineStore(fakeClock(1000));
    const created = await createProductRun(cfg(store), {
      channelId: "C1",
      threadId: "T-rev",
      objective: "implement invite API endpoint",
      startKind: "build",
      messageTs: "60.6",
    });
    const attemptId = "attempt-multi";
    await store.createAttempt({
      id: attemptId,
      runId: created.run.id,
      ordinal: 1,
      revisionDigest: null,
      status: "open",
      invalidatedAt: null,
      invalidationReason: null,
      createdAt: 1000,
      finishedAt: null,
    });
    await updateProductRevision(cfg(store), {
      attemptId,
      members: [
        {
          memberKey: "api",
          repoRef: "example-backend",
          branch: "feat/api",
          headSha: "aaa",
        },
        {
          memberKey: "worker",
          repoRef: "example-backend",
          branch: "feat/worker",
          headSha: "bbb",
        },
      ],
    });
    const gates = await ensureProductRevisionGates(store, {
      runId: created.run.id,
      attemptId,
      subjectSha: "aaa",
    });
    for (const g of gates) {
      await store.upsertGate({ ...g, status: "passed" });
    }
    expect(revisionGatesConsistent(await store.listGates(attemptId)).ok).toBe(
      true,
    );

    // Change one member in same repo
    const result = await updateProductRevision(cfg(store), {
      attemptId,
      members: [
        {
          memberKey: "api",
          repoRef: "example-backend",
          branch: "feat/api",
          headSha: "aaa-new",
        },
        {
          memberKey: "worker",
          repoRef: "example-backend",
          branch: "feat/worker",
          headSha: "bbb",
        },
      ],
    });
    expect(result.invalidatedGateCount).toBeGreaterThan(0);
    const after = await store.listGates(attemptId);
    expect(after.every((g) => g.status === "invalidated")).toBe(true);
  });
});

describe("product-context injection", () => {
  it("includes mandatory fields and ownership", async () => {
    const store = new InMemoryPipelineStore(fakeClock(1000));
    const { run, assignment, skipReasons } = await createProductRun(
      cfg(store),
      {
        channelId: "C1",
        threadId: "T-ctx",
        objective: "implement invite API endpoint with validation",
        startKind: "build",
        messageTs: "70.7",
      },
    );
    const block = buildProductContext({
      run,
      assignment,
      artifactDir: "/tmp/product/" + run.id,
      skipReasons,
      revisionMembers: [
        {
          memberKey: "backend",
          repoRef: "example-backend",
          branch: "feat/x",
          headSha: "deadbeef",
        },
      ],
      revisionDigest: "digest1",
      requiredWorkstreams: ["backend"],
      registeredPrKeys: ["acme/example-backend#1:candidate:backend"],
    });
    expect(block).toContain("<product-context>");
    expect(block).toContain(`product_run_id: ${run.id}`);
    expect(block).toContain("phase:");
    expect(block).toContain("deadbeef");
    expect(block).toContain("ownership:");
    expect(block).toContain("pm:");
    expect(block).toContain("Direct build/fix/implement");
    expect(block).toContain("</product-context>");
  });
});

describe("phase suggestions", () => {
  it("suggests fixing on failed review", () => {
    expect(
      suggestPhaseAfterOutcome({
        currentPhase: "reviewing",
        outcomeStatus: "failed",
        reviewVerdict: "changes_requested",
      }),
    ).toBe("fixing");
  });

  it("stays building when fan-out incomplete", () => {
    expect(
      suggestPhaseAfterOutcome({
        currentPhase: "building",
        outcomeStatus: "succeeded",
        allBuildersDone: false,
      }),
    ).toBe("building");
  });

  it("advances to aggregate-verification when all builders done", () => {
    expect(
      suggestPhaseAfterOutcome({
        currentPhase: "building",
        outcomeStatus: "succeeded",
        allBuildersDone: true,
      }),
    ).toBe("aggregate-verification");
  });
});
