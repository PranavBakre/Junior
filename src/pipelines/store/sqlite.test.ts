import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fakeClock } from "../../time/clock.ts";
import { SqlitePipelineStore } from "./sqlite.ts";
import { makeAssignmentCreate, makeProductRun } from "./test-helpers.ts";
import type { AgentOutcome, PipelineAttempt, PipelineGate } from "../types.ts";

function baseOutcome(overrides: Partial<AgentOutcome> = {}): AgentOutcome {
  return {
    assignmentId: "asg-1",
    expectedRunVersion: 0,
    action: "continue_self",
    status: "progress",
    reason: "still working",
    evidenceRefs: ["e1"],
    artifactRefs: [],
    blockers: [],
    checks: [],
    progressFingerprint: "fp-1",
    ...overrides,
  };
}

describe("SqlitePipelineStore", () => {
  let tmpDir: string;
  let store: SqlitePipelineStore;
  const clock = fakeClock(1_000);

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "junior-pipeline-"));
    clock.set(1_000);
    store = new SqlitePipelineStore(join(tmpDir, "test.db"), clock);
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("round-trips runs and assignments", async () => {
    await store.createRun(makeProductRun());
    await store.createAssignment(makeAssignmentCreate());
    const run = await store.getRun("run-1");
    expect(run?.kind).toBe("product");
    expect(run?.threadId).toBe("T1");
    const asg = await store.getAssignment("asg-1");
    expect(asg?.targetAgent).toBe("build");
    expect((await store.getRunByThread("T1"))?.id).toBe("run-1");
  });

  it("is idempotent on assignment idempotency keys", async () => {
    await store.createRun(makeProductRun());
    const a1 = await store.createAssignment(makeAssignmentCreate());
    const a2 = await store.createAssignment(
      makeAssignmentCreate({ id: "different-id" }),
    );
    expect(a2.id).toBe(a1.id);
  });

  it("returns duplicate receipt for outcome idempotency keys", async () => {
    await store.createRun(makeProductRun());
    await store.createAssignment(makeAssignmentCreate());

    const first = await store.recordOutcomeTransaction({
      outcome: baseOutcome(),
      toPhase: "aggregate-verification",
      actorType: "agent",
      actorId: "build",
      idempotencyKey: "out-1",
    });
    expect(first.status).toBe("accepted");

    const second = await store.recordOutcomeTransaction({
      outcome: baseOutcome({
        expectedRunVersion: 1,
        progressFingerprint: "fp-2",
        reason: "retry",
      }),
      toPhase: "pr-open",
      actorType: "agent",
      actorId: "build",
      idempotencyKey: "out-1",
    });
    expect(second.status).toBe("duplicate");
    expect((await store.getRun("run-1"))?.stateVersion).toBe(1);
  });

  it("rejects CAS conflicts on state_version", async () => {
    await store.createRun(makeProductRun());
    await store.createAssignment(makeAssignmentCreate());

    const accepted = await store.recordOutcomeTransaction({
      outcome: baseOutcome(),
      toPhase: "aggregate-verification",
      actorType: "agent",
      actorId: "build",
    });
    expect(accepted.status).toBe("accepted");

    const stale = await store.recordOutcomeTransaction({
      outcome: baseOutcome({
        expectedRunVersion: 0,
        progressFingerprint: "fp-2",
        evidenceRefs: ["e2"],
      }),
      toPhase: "pr-open",
      actorType: "agent",
      actorId: "build",
    });
    expect(stale.status).toBe("rejected");
    expect(stale.reason).toMatch(/state version conflict/i);
  });

  it("rejects mutation on terminal runs (immutability)", async () => {
    await store.createRun(
      makeProductRun({ phase: "ready-for-human-merge" }),
    );
    await store.createAssignment(makeAssignmentCreate());

    const ship = await store.recordOutcomeTransaction({
      outcome: baseOutcome({
        action: "complete",
        status: "succeeded",
        reason: "all PRs merged",
      }),
      toPhase: "shipped",
      actorType: "human",
      actorId: "U1",
    });
    expect(ship.status).toBe("accepted");
    expect((await store.getRun("run-1"))?.terminalOutcome).toBe("shipped");

    const again = await store.recordOutcomeTransaction({
      outcome: baseOutcome({
        expectedRunVersion: 1,
        action: "complete",
        status: "succeeded",
        progressFingerprint: "fp-2",
        evidenceRefs: ["e2"],
        reason: "cleanup twice",
      }),
      actorType: "system",
      actorId: "system",
    });
    expect(again.status).toBe("rejected");
    expect(again.reason).toMatch(/terminal/i);
  });

  it("invalidates aggregate gates when any revision member changes", async () => {
    await store.createRun(makeProductRun({ activeAttemptId: "att-1" }));
    const attempt: PipelineAttempt = {
      id: "att-1",
      runId: "run-1",
      ordinal: 1,
      revisionDigest: null,
      status: "open",
      invalidatedAt: null,
      invalidationReason: null,
      createdAt: 1000,
      finishedAt: null,
    };
    await store.createAttempt(attempt);

    const first = await store.replaceAttemptRevision("att-1", [
      {
        memberKey: "backend",
        repoRef: "example-backend",
        branch: "feature/x",
        headSha: "sha-a",
      },
      {
        memberKey: "frontend",
        repoRef: "example-frontend",
        branch: "feature/x",
        headSha: "sha-f",
      },
    ]);

    // Review on SHA A, validation on SHA B must not share aggregate pass —
    // we model that by binding gates to subjectSha and invalidating on digest change.
    await store.upsertGate({
      id: "gate-review",
      runId: "run-1",
      attemptId: "att-1",
      memberKey: "backend",
      githubResourceId: null,
      gateKind: "review",
      status: "passed",
      subjectSha: "sha-a",
      evidenceRef: "review-1",
      provider: "claude",
      model: null,
      agentName: "review",
      updatedAt: 1000,
    });
    await store.upsertGate({
      id: "gate-validation",
      runId: "run-1",
      attemptId: "att-1",
      memberKey: "backend",
      githubResourceId: null,
      gateKind: "validation",
      // Different subject SHA from review — aggregate must not stay passed
      // after any member of the vector changes.
      status: "passed",
      subjectSha: "sha-b",
      evidenceRef: "val-1",
      provider: "claude",
      model: null,
      agentName: "reproducer",
      updatedAt: 1000,
    } satisfies PipelineGate);
    await store.upsertGate({
      id: "gate-agg",
      runId: "run-1",
      attemptId: "att-1",
      memberKey: null,
      githubResourceId: null,
      gateKind: "aggregate",
      status: "passed",
      subjectSha: first.digest,
      evidenceRef: null,
      provider: null,
      model: null,
      agentName: null,
      updatedAt: 1000,
    });

    const second = await store.replaceAttemptRevision("att-1", [
      {
        memberKey: "backend",
        repoRef: "example-backend",
        branch: "feature/x",
        headSha: "sha-a",
      },
      {
        memberKey: "frontend",
        repoRef: "example-frontend",
        branch: "feature/x",
        headSha: "sha-f2",
      },
    ]);
    expect(second.invalidatedGateCount).toBe(3);
    const gates = await store.listGates("att-1");
    expect(gates.every((g) => g.status === "invalidated")).toBe(true);
  });

  it("persists outcomes, events, and outbox atomically on handoff", async () => {
    await store.createRun(makeProductRun({ phase: "pr-open" }));
    await store.createAssignment(makeAssignmentCreate());

    const receipt = await store.recordOutcomeTransaction({
      outcome: baseOutcome({
        action: "handoff",
        status: "progress",
        targetAgent: "review",
        reason: "ready for review",
        nextAssignment: {
          parentAssignmentId: "asg-1",
          targetAgent: "review",
          objective: "review PR",
          contextRefs: [],
          artifactRefs: [],
          acceptanceCriteria: [],
          mutationScope: [],
          dependsOn: [],
          attempt: 1,
          attemptId: null,
          candidateRevisionDigest: null,
          deadlineAt: null,
          idempotencyKey: "handoff-review-1",
        },
      }),
      toPhase: "reviewing",
      actorType: "agent",
      actorId: "build",
      idempotencyKey: "tx-1",
    });
    expect(receipt.status).toBe("accepted");
    expect(receipt.runVersion).toBe(1);

    const outcomes = await store.listOutcomes("asg-1");
    expect(outcomes).toHaveLength(1);

    const events = await store.listEvents("run-1");
    expect(events).toHaveLength(1);
    expect(events[0]!.fromPhase).toBe("pr-open");
    expect(events[0]!.toPhase).toBe("reviewing");

    const outbox = await store.listOutbox("run-1");
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.eventType).toBe("assignment.dispatch");
  });

  it("claims and reclaims outbox with fake clock", async () => {
    await store.createRun(makeProductRun());
    await store.enqueueOutbox({
      id: "ob-1",
      runId: "run-1",
      assignmentId: null,
      eventType: "assignment.dispatch",
      payload: {},
      idempotencyKey: "ob-1",
    });

    const claimed = await store.claimOutbox("w1", 5, 2_000);
    expect(claimed).toHaveLength(1);

    clock.advance(2_001);
    expect(await store.reclaimExpiredOutboxLeases(clock.now())).toBe(1);

    const again = await store.claimOutbox("w2", 5, 2_000);
    expect(again[0]!.leaseOwner).toBe("w2");
    await store.markOutboxDelivered(again[0]!.id);
    expect((await store.listOutbox("run-1"))[0]!.status).toBe("delivered");
  });

  it("rejects a second active run on the same thread", async () => {
    await store.createRun(makeProductRun({ id: "run-a", threadId: "T-active" }));
    await expect(
      store.createRun(
        makeProductRun({ id: "run-b", threadId: "T-active", phase: "discovery" }),
      ),
    ).rejects.toThrow(/active pipeline run already exists/);
  });

  it("allows a new active run after the prior run is terminal", async () => {
    await store.createRun(
      makeProductRun({
        id: "run-term",
        threadId: "T-term",
        status: "terminal",
        phase: "shipped",
        terminalOutcome: "shipped",
      }),
    );
    await store.createRun(
      makeProductRun({
        id: "run-after-term",
        threadId: "T-term",
        status: "active",
        phase: "discovery",
      }),
    );
    const active = await store.getRunByThread("T-term");
    expect(active?.id).toBe("run-after-term");
  });

  it("migrates legacy UNIQUE(assignment_id) so multi-repo jobs can coexist", async () => {
    // Simulate a pre-migration DB: table with UNIQUE(assignment_id) only.
    const legacyPath = join(tmpDir, "legacy-devserver.db");
    const { Database } = await import("bun:sqlite");
    const legacy = new Database(legacyPath);
    legacy.run("PRAGMA foreign_keys = ON");
    legacy.run(`
      CREATE TABLE pipeline_runs (
        id TEXT PRIMARY KEY,
        kind TEXT, definition_version INTEGER, channel_id TEXT, thread_id TEXT,
        phase TEXT, status TEXT, owner_agent TEXT, repo_refs_json TEXT,
        acceptance_json TEXT, artifact_refs_json TEXT, blocker_refs_json TEXT,
        active_attempt_id TEXT, state_version INTEGER, deadline_at INTEGER,
        terminal_outcome TEXT, terminal_reason TEXT, created_at INTEGER, updated_at INTEGER
      )
    `);
    legacy.run(`
      CREATE TABLE dev_server_jobs (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        assignment_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        repo TEXT NOT NULL,
        branch TEXT NOT NULL,
        status TEXT NOT NULL,
        ready_url TEXT,
        lease_owner TEXT,
        lease_expires_at INTEGER,
        deadline_at INTEGER NOT NULL,
        pid INTEGER,
        error TEXT,
        released_at INTEGER,
        release_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (assignment_id)
      )
    `);
    legacy.close();

    const migrated = new SqlitePipelineStore(legacyPath, clock);
    await migrated.createRun(makeProductRun({ id: "run-m", threadId: "T-m" }));
    const j1 = await migrated.createDevServerJob({
      id: "job-a",
      runId: "run-m",
      assignmentId: "asg-shared",
      channelId: "C",
      threadId: "T-m",
      repo: "backend",
      branch: "main",
      status: "ready",
      deadlineAt: 10_000,
    });
    const j2 = await migrated.createDevServerJob({
      id: "job-b",
      runId: "run-m",
      assignmentId: "asg-shared",
      channelId: "C",
      threadId: "T-m",
      repo: "frontend",
      branch: "main",
      status: "ready",
      deadlineAt: 10_000,
    });
    expect(j1.id).toBe("job-a");
    expect(j2.id).toBe("job-b");
    const listed = await migrated.listDevServerJobs({ runId: "run-m" });
    expect(listed).toHaveLength(2);
    migrated.close();
  });

  it("createRunWithAssignment is all-or-nothing", async () => {
    const assignment = await store.createRunWithAssignment({
      run: makeProductRun({ id: "run-atomic", threadId: "T-atomic" }),
      assignment: makeAssignmentCreate({
        id: "asg-atomic",
        runId: "run-atomic",
        idempotencyKey: "atomic-1",
      }),
    });
    expect(assignment.id).toBe("asg-atomic");
    expect((await store.getRun("run-atomic"))?.id).toBe("run-atomic");

    // Second concurrent-style create on same thread must not leave a half-run.
    await expect(
      store.createRunWithAssignment({
        run: makeProductRun({ id: "run-atomic-2", threadId: "T-atomic" }),
        assignment: makeAssignmentCreate({
          id: "asg-atomic-2",
          runId: "run-atomic-2",
          idempotencyKey: "atomic-2",
        }),
      }),
    ).rejects.toThrow(/active pipeline run already exists/);
    expect(await store.getRun("run-atomic-2")).toBeUndefined();
  });

  it("atomically persists GitHub snapshots and multi-PR semantic events without wakes", async () => {
    await store.createRun(makeProductRun({ id: "run-1", threadId: "T1" }));
    await store.createRun(
      makeProductRun({ id: "run-2", threadId: "T2", phase: "reviewing" }),
    );

    const snapshot = {
      state: "OPEN" as const,
      isDraft: false,
      baseRefName: "main",
      headRefName: "feat",
      headRefOid: "sha-a",
      reviewDecision: null,
      mergeable: "MERGEABLE" as const,
      mergedAt: null,
      closedAt: null,
      checkRollup: "PENDING" as const,
      checkRollupSha: "sha-a",
      updatedAt: "t0",
    };

    await store.upsertGitHubResource({
      id: "res-1",
      kind: "pull_request",
      owner: "acme",
      repo: "backend",
      number: 1,
      nodeId: "PR_1",
      snapshot,
      lastPolledAt: 1_000,
      nextPollAt: 1_000,
      pollClass: "hot",
      consecutiveFailures: 0,
      lastError: null,
      leaseOwner: null,
      leaseUntil: null,
      terminalAt: null,
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    await store.upsertGitHubResource({
      id: "res-2",
      kind: "pull_request",
      owner: "acme",
      repo: "backend",
      number: 2,
      nodeId: "PR_2",
      snapshot: { ...snapshot, headRefOid: "sha-b", checkRollupSha: "sha-b" },
      lastPolledAt: 1_000,
      nextPollAt: 1_000,
      pollClass: "warm",
      consecutiveFailures: 0,
      lastError: null,
      leaseOwner: null,
      leaseUntil: null,
      terminalAt: null,
      createdAt: 1_000,
      updatedAt: 1_000,
    });

    await store.registerPipelineGitHubResource({
      id: "pg-1",
      runId: "run-1",
      resourceId: "res-1",
      role: "dev-pr",
      workstreamKey: "backend",
      attemptId: "att-1",
      registeredByAssignmentId: null,
      expectedHeadSha: "sha-a",
      active: true,
    });
    await store.registerPipelineGitHubResource({
      id: "pg-2",
      runId: "run-1",
      resourceId: "res-2",
      role: "main-pr",
      workstreamKey: "backend",
      attemptId: "att-1",
      registeredByAssignmentId: null,
      expectedHeadSha: "sha-b",
      active: true,
    });
    await store.registerPipelineGitHubResource({
      id: "pg-3",
      runId: "run-2",
      resourceId: "res-1",
      role: "review-target",
      workstreamKey: "backend",
      attemptId: "att-2",
      registeredByAssignmentId: null,
      expectedHeadSha: "sha-a",
      active: true,
    });

    const result = await store.applyGitHubSnapshotShadow({
      resourceId: "res-1",
      snapshot: { ...snapshot, headRefOid: "sha-a2", checkRollupSha: "sha-a2" },
      nodeId: "PR_1",
      events: [
        {
          type: "github.pr.head_changed",
          resourceId: "res-1",
          owner: "acme",
          repo: "backend",
          number: 1,
          observedAt: 1_000,
          previous: { headRefOid: "sha-a" },
          next: { headRefOid: "sha-a2" },
          fingerprint: "res-1:github.pr.head_changed:sha-a->sha-a2",
        },
      ],
      proposedReductions: [
        {
          kind: "invalidate_aggregate_gates",
          reason: "head_changed",
          resourceId: "res-1",
          attemptId: "att-1",
          workstreamKey: "backend",
          previousHeadSha: "sha-a",
          nextHeadSha: "sha-a2",
        },
      ],
      nextPollAt: 31_000,
    });

    expect(result.wakesDelivered).toBe(false);
    expect(result.associationsTouched).toBe(2);

    const updated = await store.getGitHubResource("res-1");
    expect(updated?.snapshot?.headRefOid).toBe("sha-a2");

    const events1 = await store.listEvents("run-1");
    const events2 = await store.listEvents("run-2");
    expect(events1.some((e) => e.eventType === "github.pr.head_changed")).toBe(
      true,
    );
    expect(events2.some((e) => e.eventType === "github.pr.head_changed")).toBe(
      true,
    );
    expect(await store.listOutbox("run-1")).toEqual([]);
    expect(await store.listOutbox("run-2")).toEqual([]);

    // Same-repo multi-PR associations remain distinct.
    const assocs = await store.listPipelineGitHubResources("run-1", true);
    expect(assocs).toHaveLength(2);
    expect(new Set(assocs.map((a) => a.resourceId)).size).toBe(2);
    expect(assocs.map((a) => a.role).sort()).toEqual(["dev-pr", "main-pr"]);
  });
});
