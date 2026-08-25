import { describe, expect, it } from "bun:test";
import { validateOutcome } from "./policy.ts";
import type { AgentOutcome, Assignment, ProductRun } from "./types.ts";
import { PIPELINE_DEFINITION_VERSION } from "./types.ts";

function productRun(overrides: Partial<ProductRun> = {}): ProductRun {
  return {
    id: "run-1",
    kind: "product",
    definitionVersion: PIPELINE_DEFINITION_VERSION,
    channelId: "C1",
    threadId: "T1",
    phase: "building",
    status: "active",
    ownerAgent: "build",
    repoRefs: ["example-backend"],
    acceptanceCriteria: [],
    artifactRefs: [],
    blockerRefs: [],
    activeAttemptId: null,
    stateVersion: 3,
    deadlineAt: null,
    terminalOutcome: null,
    terminalReason: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function assignment(overrides: Partial<Assignment> = {}): Assignment {
  return {
    id: "asg-1",
    runId: "run-1",
    parentAssignmentId: null,
    sourceAgent: "system",
    sourceSlackUserId: null,
    targetAgent: "build",
    skillRef: null,
    capabilityRefs: [],
    status: "leased",
    objective: "implement feature",
    contextRefs: [],
    artifactRefs: [],
    acceptanceCriteria: [],
    mutationScope: ["src/"],
    dependsOn: [],
    attempt: 1,
    attemptId: null,
    candidateRevisionDigest: null,
    deadlineAt: null,
    leaseOwner: "worker-1",
    leaseExpiresAt: 10_000,
    idempotencyKey: "idem-1",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function outcome(overrides: Partial<AgentOutcome> = {}): AgentOutcome {
  return {
    assignmentId: "asg-1",
    expectedRunVersion: 3,
    action: "continue_self",
    status: "progress",
    reason: "working",
    evidenceRefs: [],
    artifactRefs: [],
    blockers: [],
    checks: [],
    progressFingerprint: "fp-a",
    ...overrides,
  };
}

describe("validateOutcome", () => {
  it("accepts a continue_self on an active run", () => {
    const result = validateOutcome({
      run: productRun(),
      assignment: assignment(),
      outcome: outcome(),
      recentFingerprints: [],
      now: 1_000,
    });
    expect(result).toEqual({ ok: true, receiptStatus: "accepted" });
  });

  it("rejects mutation on terminal runs", () => {
    const result = validateOutcome({
      run: productRun({ phase: "shipped", status: "terminal", terminalOutcome: "shipped" }),
      assignment: assignment(),
      outcome: outcome(),
      recentFingerprints: [],
      now: 1_000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.receiptStatus).toBe("rejected");
      expect(result.reason).toMatch(/terminal/i);
    }
  });

  it("escalates missing_authority when action is not escalate", () => {
    const result = validateOutcome({
      run: productRun(),
      assignment: assignment(),
      outcome: outcome({
        blockers: [{ kind: "missing_authority", detail: "merge main" }],
      }),
      recentFingerprints: [],
      now: 1_000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.receiptStatus).toBe("escalated");
      expect(result.reason).toMatch(/missing_authority/);
    }
  });

  it("accepts escalate with missing_authority", () => {
    const result = validateOutcome({
      run: productRun(),
      assignment: assignment(),
      outcome: outcome({
        action: "escalate",
        status: "blocked",
        blockers: [{ kind: "missing_authority", detail: "merge main" }],
      }),
      recentFingerprints: [],
      now: 1_000,
    });
    expect(result).toEqual({ ok: true, receiptStatus: "escalated" });
  });

  it("requires wait condition name and future deadline", () => {
    const missing = validateOutcome({
      run: productRun(),
      assignment: assignment(),
      outcome: outcome({ action: "wait", status: "blocked" }),
      recentFingerprints: [],
      now: 1_000,
    });
    expect(missing.ok).toBe(false);

    const past = validateOutcome({
      run: productRun(),
      assignment: assignment(),
      outcome: outcome({
        action: "wait",
        status: "blocked",
        wait: { conditionName: "pr.checks", deadlineAt: 500 },
      }),
      recentFingerprints: [],
      now: 1_000,
    });
    expect(past.ok).toBe(false);

    const ok = validateOutcome({
      run: productRun(),
      assignment: assignment(),
      outcome: outcome({
        action: "wait",
        status: "blocked",
        wait: { conditionName: "pr.checks", deadlineAt: 5_000 },
      }),
      recentFingerprints: [],
      now: 1_000,
    });
    expect(ok).toEqual({ ok: true, receiptStatus: "waiting" });
  });

  it("requires a scheduled wake between now and the final deadline", () => {
    const run = productRun();
    const activeAssignment = assignment();
    const base = outcome({
      action: "wait",
      status: "blocked",
      wait: {
        conditionName: "new-member-channel-poll",
        wakeAt: 2_000,
        deadlineAt: 5_000,
      },
    });

    expect(validateOutcome({
      run,
      assignment: activeAssignment,
      outcome: base,
      recentFingerprints: [],
      now: 1_000,
    }).ok).toBe(true);
    expect(validateOutcome({
      run,
      assignment: activeAssignment,
      outcome: {
        ...base,
        wait: { ...base.wait!, wakeAt: 6_000 },
      },
      recentFingerprints: [],
      now: 1_000,
    })).toMatchObject({
      ok: false,
      reason: "wait.wakeAt must not be after wait.deadlineAt",
    });
  });

  it("detects fingerprint repeats without new evidence", () => {
    const result = validateOutcome({
      run: productRun(),
      assignment: assignment(),
      outcome: outcome({ progressFingerprint: "fp-a", evidenceRefs: [] }),
      recentFingerprints: ["fp-a"],
      now: 1_000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.receiptStatus).toBe("escalated");
      expect(result.reason).toMatch(/fingerprint/i);
    }
  });

  it("allows same fingerprint when new evidence is attached", () => {
    const result = validateOutcome({
      run: productRun(),
      assignment: assignment(),
      outcome: outcome({
        progressFingerprint: "fp-a",
        evidenceRefs: ["evidence/log-2.md"],
      }),
      recentFingerprints: ["fp-a"],
      now: 1_000,
    });
    expect(result).toEqual({ ok: true, receiptStatus: "accepted" });
  });

  it("rejects reviewer completion without verdict and runtime evidence receipts", () => {
    const result = validateOutcome({
      run: productRun({ phase: "reviewing" }),
      assignment: assignment({ targetAgent: "review" }),
      outcome: outcome({ action: "complete", status: "succeeded" }),
      recentFingerprints: [],
      now: 1_000,
    });

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("review/verdict check"),
    });
  });

  it("accepts reviewer completion with pinned verdict and runtime evidence", () => {
    const result = validateOutcome({
      run: productRun({ phase: "reviewing" }),
      assignment: assignment({ targetAgent: "review" }),
      outcome: outcome({
        action: "complete",
        status: "succeeded",
        checks: [
          {
            name: "review",
            status: "passed",
            evidenceRef: "github-review:5017170778@b8c65c3",
          },
          {
            name: "runtime-evidence",
            status: "passed",
            evidenceRef: "test:rich-text-list-markers:passed",
          },
        ],
      }),
      recentFingerprints: [],
      now: 1_000,
    });

    expect(result).toEqual({ ok: true, receiptStatus: "accepted" });
  });

  it("requires an explicit reason when runtime evidence is not applicable", () => {
    const base = outcome({
      action: "complete",
      status: "failed",
      checks: [
        {
          name: "verdict",
          status: "failed",
          evidenceRef: "github-review:42@deadbeef",
        },
        {
          name: "runtime-evidence",
          status: "skipped",
          evidenceRef: "could-not-run",
        },
      ],
    });
    const context = {
      run: productRun({ phase: "reviewing" }),
      assignment: assignment({ targetAgent: "review" }),
      recentFingerprints: [],
      now: 1_000,
    };

    expect(validateOutcome({ ...context, outcome: base })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("not-applicable:<reason>"),
    });
    expect(validateOutcome({
      ...context,
      outcome: {
        ...base,
        checks: base.checks.map((check) =>
          check.name === "runtime-evidence"
            ? { ...check, evidenceRef: "not-applicable:docs-only change" }
            : check),
      },
    })).toEqual({ ok: true, receiptStatus: "accepted" });
  });

  it("requires handoff targetAgent and nextAssignment", () => {
    const missing = validateOutcome({
      run: productRun(),
      assignment: assignment(),
      outcome: outcome({ action: "handoff", status: "progress" }),
      recentFingerprints: [],
      now: 1_000,
    });
    expect(missing.ok).toBe(false);

    const ok = validateOutcome({
      run: productRun(),
      assignment: assignment(),
      outcome: outcome({
        action: "handoff",
        status: "progress",
        targetAgent: "review",
        nextAssignment: {
          parentAssignmentId: "asg-1",
          sourceSlackUserId: null,
          targetAgent: "review",
          objective: "review changes",
          contextRefs: [],
          artifactRefs: [],
          acceptanceCriteria: [],
          mutationScope: [],
          dependsOn: [],
          attempt: 1,
          attemptId: null,
          candidateRevisionDigest: null,
          deadlineAt: null,
          idempotencyKey: "handoff-1",
        },
      }),
      recentFingerprints: [],
      now: 1_000,
    });
    expect(ok).toEqual({ ok: true, receiptStatus: "accepted" });
  });

  it("rejects stale expectedRunVersion", () => {
    const result = validateOutcome({
      run: productRun({ stateVersion: 5 }),
      assignment: assignment(),
      outcome: outcome({ expectedRunVersion: 3 }),
      recentFingerprints: [],
      now: 1_000,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/state version conflict/);
    }
  });
});
