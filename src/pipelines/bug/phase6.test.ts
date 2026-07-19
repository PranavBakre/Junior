/**
 * Phase 6: bug controller modes, durable dev-server jobs, GitHub wakes.
 */
import { describe, expect, it } from "bun:test";
import { fakeClock } from "../../time/clock.ts";
import { InMemoryPipelineStore } from "../store/memory.ts";
import { makeAssignmentCreate } from "../store/test-helpers.ts";
import {
  createBugRun,
  ensureRevisionBoundGates,
  loadBugMode,
  onDevServerReady,
  reduceBugOutcome,
  reduceGitHubEventsForWakes,
  shouldCreateBugRun,
  shouldUseDurableDevServer,
} from "./controller.ts";
import {
  evidenceIsProportional,
  revisionGatesConsistent,
} from "./policy.ts";
import {
  evidencePlanForMode,
  selectBugMode,
} from "./definition.ts";
import { buildBugContext } from "./context.ts";
import {
  releaseDevServerJobOnce,
  requestDevServerJob,
  reclaimDevServerJobs,
  DEVSERVER_READY_CONDITION,
} from "../dev-server-jobs.ts";
import type { AgentOutcome, BugRun } from "../types.ts";

function cfg(store: InMemoryPipelineStore, clock = fakeClock(1_000)) {
  return {
    store,
    jobStore: store,
    clock,
    eventWakeEnabled: true,
  };
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

describe("bug mode selection", () => {
  it("selects expected-behavior from hints", () => {
    expect(selectBugMode({ hint: "this is working as intended" })).toBe(
      "expected-behavior",
    );
  });

  it("selects full-investigation for systemic hints", () => {
    expect(selectBugMode({ hint: "systemic outage across services" })).toBe(
      "full-investigation",
    );
  });

  it("defaults to focused-debug", () => {
    expect(selectBugMode({ hint: "button does nothing" })).toBe(
      "focused-debug",
    );
  });

  it("focused and full choose evidence proportionally", () => {
    const focused = evidencePlanForMode("focused-debug");
    const full = evidencePlanForMode("full-investigation");
    expect(focused.required.length).toBeLessThan(full.required.length);
    expect(full.required).toContain("metrics");
    expect(focused.required).not.toContain("metrics");

    const focusedOk = evidenceIsProportional(
      "focused-debug",
      ["report", "reproduction", "code-path"],
      [],
    );
    expect(focusedOk.ok).toBe(true);

    const fullMissing = evidenceIsProportional(
      "full-investigation",
      ["report", "reproduction"],
      [],
    );
    expect(fullMissing.ok).toBe(false);
    expect(fullMissing.missing).toContain("logs");
  });
});

describe("shouldCreateBugRun / durable gates", () => {
  it("requires BUG_PIPELINE_ENABLED + active + explicit start", () => {
    expect(
      shouldCreateBugRun({
        bugPipelineEnabled: false,
        runtimeMode: "active",
        explicitStart: true,
      }),
    ).toBe(false);
    expect(
      shouldCreateBugRun({
        bugPipelineEnabled: true,
        runtimeMode: "off",
        explicitStart: true,
      }),
    ).toBe(false);
    expect(
      shouldCreateBugRun({
        bugPipelineEnabled: true,
        runtimeMode: "active",
        explicitStart: false,
      }),
    ).toBe(false);
    expect(
      shouldCreateBugRun({
        bugPipelineEnabled: true,
        runtimeMode: "active",
        explicitStart: true,
      }),
    ).toBe(true);
  });

  it("durable dev-server only when active bug run + flags", () => {
    expect(
      shouldUseDurableDevServer({
        bugPipelineEnabled: true,
        runtimeMode: "active",
        hasActiveBugRun: true,
      }),
    ).toBe(true);
    expect(
      shouldUseDurableDevServer({
        bugPipelineEnabled: false,
        runtimeMode: "active",
        hasActiveBugRun: true,
      }),
    ).toBe(false);
    expect(
      shouldUseDurableDevServer({
        bugPipelineEnabled: true,
        runtimeMode: "off",
        hasActiveBugRun: true,
      }),
    ).toBe(false);
  });
});

describe("createBugRun + expected-behavior terminal", () => {
  it("creates a BugRun on explicit start", async () => {
    const store = new InMemoryPipelineStore(fakeClock(1000));
    const result = await createBugRun(cfg(store), {
      channelId: "CBUGS",
      threadId: "T1",
      objective: "list is empty for user X",
      startKind: "reproducer",
      messageTs: "111.222",
    });
    expect(result.created).toBe(true);
    expect(result.run.kind).toBe("bug");
    expect(result.mode).toBe("focused-debug");
    expect(result.assignment.targetAgent).toBe("reproducer");
    expect(await loadBugMode(store, result.run.id)).toBe("focused-debug");

    const cursor = await store.getThreadCursor(result.run.id);
    expect(cursor?.threadId).toBe("T1");
    expect(cursor?.lastObservedTs).toBe("111.222");
  });

  it("expected behavior terminates without code", async () => {
    const clock = fakeClock(1000);
    const store = new InMemoryPipelineStore(clock);
    const { run, assignment } = await createBugRun(cfg(store, clock), {
      channelId: "C",
      threadId: "T-eb",
      objective: "this is expected behavior / working as intended",
      startKind: "debug",
      messageTs: "1.1",
      explicitMode: "expected-behavior",
    });
    expect(await loadBugMode(store, run.id)).toBe("expected-behavior");

    // Advance intake → diagnosis via complete with expected_behavior.
    const receipt = await reduceBugOutcome(cfg(store, clock), {
      actorId: "reproducer",
      outcome: baseOutcome({
        assignmentId: assignment.id,
        expectedRunVersion: 0,
        action: "complete",
        status: "expected_behavior",
        reason: "product works as documented; no code change",
        progressFingerprint: "eb-1",
        evidenceRefs: ["report:ticket"],
      }),
    });
    expect(receipt.status).toBe("accepted");
    const updated = await store.getRun(run.id);
    expect(updated?.phase).toBe("expected-behavior");
    expect(updated?.status).toBe("terminal");
    expect(updated?.terminalOutcome).toBe("expected-behavior");
    // No mutation was required.
    expect(assignment.mutationScope).toEqual([]);
  });

  it("idempotent reuse of active run on same thread", async () => {
    const store = new InMemoryPipelineStore(fakeClock(1000));
    const first = await createBugRun(cfg(store), {
      channelId: "C",
      threadId: "T-same",
      objective: "bug",
      startKind: "debug",
      messageTs: "1",
    });
    const second = await createBugRun(cfg(store), {
      channelId: "C",
      threadId: "T-same",
      objective: "bug again",
      startKind: "reproducer",
      messageTs: "2",
    });
    expect(second.created).toBe(false);
    expect(second.run.id).toBe(first.run.id);
  });
});

describe("dev-server durable jobs", () => {
  it("devserver.ready resumes exact assignment", async () => {
    const clock = fakeClock(1000);
    const store = new InMemoryPipelineStore(clock);
    const { run, assignment } = await createBugRun(cfg(store, clock), {
      channelId: "C",
      threadId: "T-ds",
      objective: "validate fix",
      startKind: "reproducer",
      messageTs: "9.9",
    });

    // Put assignment into wait for devserver.ready (phase may stay intake —
    // durable job is keyed off the wait condition, not the phase name).
    const waitReceipt = await reduceBugOutcome(cfg(store, clock), {
      actorId: "reproducer",
      outcome: baseOutcome({
        assignmentId: assignment.id,
        expectedRunVersion: 0,
        action: "wait",
        status: "progress",
        reason: "need local server",
        progressFingerprint: "wait-ds",
        wait: {
          conditionName: DEVSERVER_READY_CONDITION,
          deadlineAt: clock.now() + 600_000,
        },
      }),
    });
    expect(waitReceipt.status).toBe("waiting");

    const job = await store.getDevServerJobByAssignment(assignment.id);
    expect(job).toBeDefined();
    expect(job?.status).toBe("requested");

    const resume = await onDevServerReady(cfg(store, clock), {
      jobId: job!.id,
      readyUrl: "http://localhost:3000",
      pid: 4242,
    });
    expect(resume.resumed).toBe(true);
    expect(resume.assignmentId).toBe(assignment.id);

    const readyJob = await store.getDevServerJob(job!.id);
    expect(readyJob?.status).toBe("ready");
    expect(readyJob?.readyUrl).toBe("http://localhost:3000");

    const outbox = await store.listOutbox(run.id);
    const resumeItem = outbox.find(
      (o) =>
        o.eventType === "assignment.resume" &&
        o.assignmentId === assignment.id,
    );
    expect(resumeItem).toBeDefined();
    expect(resumeItem?.payload.readyUrl).toBe("http://localhost:3000");
  });

  it("validation success/failure/cancel/deadline release lease once", async () => {
    const clock = fakeClock(1000);
    const store = new InMemoryPipelineStore(clock);
    const job = await requestDevServerJob(store, {
      id: "job-1",
      runId: "run-x",
      assignmentId: "asg-x",
      channelId: "C",
      threadId: "T",
      repo: "backend",
      branch: "fix/bug",
      deadlineAt: 1000 + 600_000,
    });

    const first = await releaseDevServerJobOnce(store, job.id, "complete");
    expect(first.released).toBe(true);
    expect(first.job?.status).toBe("released");

    const second = await releaseDevServerJobOnce(store, job.id, "complete");
    expect(second.released).toBe(false);

    // Independent jobs for fail / cancel / deadline
    for (const [id, reason, status] of [
      ["job-fail", "fail", "failed"],
      ["job-cancel", "cancel", "cancelled"],
      ["job-deadline", "deadline", "deadline"],
    ] as const) {
      const j = await requestDevServerJob(store, {
        id,
        runId: "run-x",
        assignmentId: `asg-${id}`,
        channelId: "C",
        threadId: "T",
        repo: "backend",
        branch: "fix",
        deadlineAt: 1000 + 600_000,
      });
      const r1 = await releaseDevServerJobOnce(store, j.id, reason);
      expect(r1.released).toBe(true);
      expect(r1.job?.status).toBe(status);
      const r2 = await releaseDevServerJobOnce(store, j.id, reason);
      expect(r2.released).toBe(false);
    }
  });

  it("deadline reclaim releases open jobs once", async () => {
    const clock = fakeClock(1000);
    const store = new InMemoryPipelineStore(clock);
    const job = await requestDevServerJob(store, {
      runId: "run-d",
      assignmentId: "asg-d",
      channelId: "C",
      threadId: "T",
      repo: "backend",
      branch: "main",
      deadlineAt: 1500,
    });
    clock.set(2000);
    const report = await reclaimDevServerJobs(store, clock);
    expect(report.deadlineReleased).toBe(1);
    const updated = await store.getDevServerJob(job.id);
    expect(updated?.status).toBe("deadline");

    const again = await reclaimDevServerJobs(store, clock);
    expect(again.deadlineReleased).toBe(0);
  });
});

describe("revision-bound gates and rework", () => {
  it("review+validation+checks share one revision vector", async () => {
    const store = new InMemoryPipelineStore(fakeClock(1000));
    const { run } = await createBugRun(cfg(store), {
      channelId: "C",
      threadId: "T-gates",
      objective: "fix and verify",
      startKind: "debug",
      messageTs: "3.3",
    });

    const attemptId = "attempt-1";
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
    const { digest } = await store.replaceAttemptRevision(attemptId, [
      {
        memberKey: "backend",
        repoRef: "example-backend",
        branch: "fix/bug",
        headSha: "aaa111",
      },
    ]);
    expect(digest).toBeTruthy();

    const gates = await ensureRevisionBoundGates(store, {
      runId: run.id,
      attemptId,
      subjectSha: "aaa111",
      memberKey: "backend",
    });
    expect(gates).toHaveLength(3);
    expect(new Set(gates.map((g) => g.subjectSha))).toEqual(new Set(["aaa111"]));
    expect(revisionGatesConsistent(gates).ok).toBe(true);

    // Divergent SHA fails consistency.
    await store.upsertGate({
      ...gates[1],
      subjectSha: "bbb222",
      status: "passed",
    });
    const refreshed = await store.listGates(attemptId);
    expect(revisionGatesConsistent(refreshed).ok).toBe(false);
  });

  it("failed validation → rework invalidates gates", async () => {
    const clock = fakeClock(1000);
    const store = new InMemoryPipelineStore(clock);
    const created = await createBugRun(cfg(store, clock), {
      channelId: "C",
      threadId: "T-rework",
      objective: "validate",
      startKind: "reproducer",
      messageTs: "4.4",
    });

    const attemptId = "attempt-rework";
    await store.createAttempt({
      id: attemptId,
      runId: created.run.id,
      ordinal: 1,
      revisionDigest: "d1",
      status: "open",
      invalidatedAt: null,
      invalidationReason: null,
      createdAt: 1000,
      finishedAt: null,
    });
    await ensureRevisionBoundGates(store, {
      runId: created.run.id,
      attemptId,
      subjectSha: "sha1",
    });
    for (const g of await store.listGates(attemptId)) {
      await store.upsertGate({ ...g, status: "passed" });
    }

    // Walk legal phases: intake → evidence → diagnosis → fixing → reviewing → validating
    let version = 0;
    const asgId = created.assignment.id;
    for (const step of [
      { phase: "evidence", fp: "to-ev" },
      { phase: "diagnosis", fp: "to-diag" },
      { phase: "fixing", fp: "to-fix" },
      { phase: "reviewing", fp: "to-rev" },
      { phase: "validating", fp: "to-val" },
    ]) {
      const r = await store.recordOutcomeTransaction({
        outcome: baseOutcome({
          assignmentId: asgId,
          expectedRunVersion: version,
          action: "continue_self",
          status: "progress",
          reason: `advance to ${step.phase}`,
          progressFingerprint: step.fp,
        }),
        toPhase: step.phase,
        actorType: "system",
        actorId: "test",
        idempotencyKey: `adv-${step.phase}`,
      });
      expect(r.status).toBe("accepted");
      version = r.runVersion;
    }

    const mem = store as unknown as { runs: Map<string, BugRun> };
    const current = mem.runs.get(created.run.id)!;
    mem.runs.set(created.run.id, {
      ...current,
      activeAttemptId: attemptId,
      phase: "validating",
      stateVersion: version,
    });

    const valAsg = await store.createAssignment(
      makeAssignmentCreate({
        id: "asg-val",
        runId: created.run.id,
        sourceAgent: "lead",
        targetAgent: "reproducer",
        objective: "validate fix",
        attemptId,
        candidateRevisionDigest: "d1",
        idempotencyKey: "asg-val-1",
        status: "leased",
      }),
    );

    const failReceipt = await reduceBugOutcome(cfg(store, clock), {
      actorId: "reproducer",
      toPhase: "fixing",
      outcome: baseOutcome({
        assignmentId: valAsg.id,
        expectedRunVersion: version,
        action: "complete",
        status: "failed",
        reason: "validation failed: still broken",
        progressFingerprint: "val-fail",
        checks: [{ name: "behavioral", status: "failed" }],
      }),
    });
    expect(failReceipt.status).toBe("accepted");

    const gates = await store.listGates(attemptId);
    expect(gates.every((g) => g.status === "invalidated")).toBe(true);

    const updated = await store.getRun(created.run.id);
    expect(updated?.phase).toBe("fixing");
  });
});

describe("GitHub wake delivery", () => {
  it("PR events during downtime wake once when wake enabled", async () => {
    const clock = fakeClock(1000);
    const store = new InMemoryPipelineStore(clock);
    const { run, assignment } = await createBugRun(cfg(store, clock), {
      channelId: "C",
      threadId: "T-gh",
      objective: "wait for checks",
      startKind: "debug",
      messageTs: "5.5",
    });

    // Put assignment waiting.
    await store.recordOutcomeTransaction({
      outcome: baseOutcome({
        assignmentId: assignment.id,
        expectedRunVersion: 0,
        action: "wait",
        status: "progress",
        reason: "waiting on checks",
        progressFingerprint: "wait-checks",
        wait: {
          conditionName: "github.checks",
          deadlineAt: 1000 + 3_600_000,
        },
      }),
      toPhase: "checks",
      actorType: "agent",
      actorId: "lead",
      idempotencyKey: "wait-checks-1",
    });

    // Simulate Phase 5 shadow event persisted while laptop slept.
    await store.appendEvent({
      id: "gh-evt-1",
      runId: run.id,
      eventType: "github.pr.checks_changed",
      actorType: "system",
      actorId: "github-reconciler",
      assignmentId: assignment.id,
      outcomeId: null,
      fromPhase: null,
      toPhase: null,
      payloadVersion: 1,
      payload: {
        resourceId: "res-1",
        role: "candidate",
        workstreamKey: "backend",
        attemptId: null,
        fingerprint: "fp-checks-1",
        shadow: true,
        wakesDelivered: false,
        next: { checkRollup: "SUCCESS", headRefOid: "abc" },
        previous: { checkRollup: "PENDING" },
      },
      idempotencyKey: "fp-checks-1:run:" + run.id + ":role:candidate",
      occurredAt: 2000,
      observedAt: 2000,
    });

    const first = await reduceGitHubEventsForWakes(cfg(store, clock), {
      runId: run.id,
    });
    expect(first.wakesEnqueued).toBe(1);

    const outbox = await store.listOutbox(run.id);
    const wakes = outbox.filter((o) => o.eventType === "assignment.resume");
    expect(wakes.length).toBe(1);
    expect(wakes[0].assignmentId).toBe(assignment.id);

    // Second reduction is idempotent.
    const second = await reduceGitHubEventsForWakes(cfg(store, clock), {
      runId: run.id,
    });
    expect(second.wakesEnqueued).toBe(0);
  });

  it("mode=off / wake disabled delivers zero wakes", async () => {
    const clock = fakeClock(1000);
    const store = new InMemoryPipelineStore(clock);
    const { run } = await createBugRun(cfg(store, clock), {
      channelId: "C",
      threadId: "T-nowake",
      objective: "x",
      startKind: "debug",
      messageTs: "6.6",
    });
    await store.appendEvent({
      id: "gh-evt-2",
      runId: run.id,
      eventType: "github.pr.merged",
      actorType: "system",
      actorId: "github-reconciler",
      assignmentId: null,
      outcomeId: null,
      fromPhase: null,
      toPhase: null,
      payloadVersion: 1,
      payload: { shadow: true, fingerprint: "fp-m", role: "dev-pr" },
      idempotencyKey: "fp-m",
      occurredAt: 1000,
      observedAt: 1000,
    });

    const result = await reduceGitHubEventsForWakes(
      { ...cfg(store, clock), eventWakeEnabled: false },
      { runId: run.id },
    );
    expect(result.wakesEnqueued).toBe(0);
  });
});

describe("bug-context injection", () => {
  it("includes mandatory fields", async () => {
    const store = new InMemoryPipelineStore(fakeClock(1000));
    const { run, assignment, mode } = await createBugRun(cfg(store), {
      channelId: "C",
      threadId: "T-ctx",
      objective: "repro empty list",
      startKind: "reproducer",
      messageTs: "7.7",
    });
    const block = buildBugContext({
      run,
      assignment,
      mode,
      artifactDir: "/tmp/bugs/" + run.id,
      revisionMembers: [
        {
          memberKey: "backend",
          repoRef: "example-backend",
          branch: "fix/x",
          headSha: "deadbeef",
        },
      ],
      revisionDigest: "digest1",
    });
    expect(block).toContain("<bug-context>");
    expect(block).toContain(`bug_run_id: ${run.id}`);
    expect(block).toContain("adaptive_mode: focused-debug");
    expect(block).toContain("artifact_dir:");
    expect(block).toContain("deadbeef");
    expect(block).toContain("</bug-context>");
  });
});
