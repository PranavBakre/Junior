/**
 * Authenticated outcomes, handoffs, outbox pump, and PR registration gate.
 */
import { describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeClock } from "../time/clock.ts";
import { InMemoryPipelineStore } from "./store/memory.ts";
import {
  makeAssignmentCreate,
  makeDefaultRun,
  makeProductRun,
} from "./store/test-helpers.ts";
import {
  parseAgentOutcome,
  registerPr,
  reportOutcome,
  requestHandoff,
} from "./outcomes.ts";
import { dispatchAssignment } from "./dispatch.ts";
import { pumpOutbox } from "./pump.ts";
import { buildAssignmentContext } from "./context.ts";
import {
  resolvePipelineArtifactPath,
  runPipelineCheck,
  writePipelineArtifact,
} from "./artifacts.ts";
import {
  pipelineGetState,
  pipelineRequestHandoff,
  type PipelineToolRuntime,
} from "./tools.ts";
import type { SlackMessageEvent } from "../slack/events.ts";
import type { ThreadSession } from "../session/types.ts";
import { createSession } from "../session/types.ts";

function auth(agent = "pm") {
  return {
    agent,
    channelId: "C1",
    threadId: "T1",
  };
}

async function seedPmRun(store: InMemoryPipelineStore) {
  await store.createRun(
    makeProductRun({
      phase: "discovery",
      ownerAgent: "pm",
      stateVersion: 0,
    }),
  );
  const assignment = await store.createAssignment(
    makeAssignmentCreate({
      id: "asg-pm",
      sourceAgent: "system",
      targetAgent: "pm",
      objective: "scope the feature",
      idempotencyKey: "asg-pm-1",
    }),
  );
  return assignment;
}

describe("parseAgentOutcome", () => {
  it("parses a valid handoff outcome", () => {
    const outcome = parseAgentOutcome({
      assignmentId: "a1",
      expectedRunVersion: 0,
      action: "handoff",
      status: "progress",
      targetAgent: "architect",
      reason: "need architecture",
      evidenceRefs: [],
      artifactRefs: [],
      blockers: [],
      checks: [],
      progressFingerprint: "fp-1",
      nextAssignment: {
        parentAssignmentId: "a1",
        targetAgent: "architect",
        objective: "design contracts",
        contextRefs: [],
        artifactRefs: [],
        acceptanceCriteria: [],
        mutationScope: [],
        dependsOn: [],
        attempt: 1,
        attemptId: null,
        candidateRevisionDigest: null,
        deadlineAt: null,
        idempotencyKey: "next-1",
      },
    });
    expect(outcome.action).toBe("handoff");
    expect(outcome.targetAgent).toBe("architect");
  });

  it("rejects missing reason", () => {
    expect(() =>
      parseAgentOutcome({
        assignmentId: "a1",
        expectedRunVersion: 0,
        action: "complete",
        status: "succeeded",
        progressFingerprint: "fp",
      }),
    ).toThrow(/reason/);
  });
});

describe("authenticated handoffs", () => {
  it("accepts PM → architect handoff", async () => {
    const store = new InMemoryPipelineStore(fakeClock(1000));
    await seedPmRun(store);

    const receipt = await requestHandoff(
      { store },
      {
        assignmentId: "asg-pm",
        expectedRunVersion: 0,
        targetAgent: "architect",
        objective: "design contracts",
        reason: "need architecture before build",
        progressFingerprint: "pm-arch-1",
        idempotencyKey: "handoff-1",
        nextIdempotencyKey: "handoff-1:next",
        auth: auth("pm"),
      },
    );

    expect(receipt.status).toBe("accepted");
    expect(receipt.runVersion).toBe(1);

    const assignments = await store.listAssignments("run-1");
    expect(assignments.some((a) => a.targetAgent === "architect")).toBe(true);

    const outbox = await store.listOutbox("run-1");
    expect(outbox.some((o) => o.eventType === "assignment.dispatch")).toBe(true);
  });

  it("persists loop-policy escalation so the assignment cannot spin", async () => {
    const store = new InMemoryPipelineStore(fakeClock(1000));
    await seedPmRun(store);

    const first = await requestHandoff(
      { store },
      {
        assignmentId: "asg-pm",
        expectedRunVersion: 0,
        targetAgent: "architect",
        objective: "design",
        reason: "first handoff",
        progressFingerprint: "same-fp",
        idempotencyKey: "loop-1",
        nextIdempotencyKey: "loop-1:next",
        auth: auth("pm"),
      },
    );
    expect(first.status).toBe("accepted");

    // Architect completes back... then PM tries the same fingerprint handoff again.
    // Seed a prior outcome with the loop key fingerprint by recording an outcome
    // event via a second handoff attempt with identical loop dimensions.
    // Re-create a pending PM assignment to report from after the first completed.
    await store.createAssignment(
      makeAssignmentCreate({
        id: "asg-pm-2",
        runId: "run-1",
        sourceAgent: "human",
        targetAgent: "pm",
        objective: "scope again",
        idempotencyKey: "asg-pm-2",
      }),
    );

    const second = await requestHandoff(
      { store },
      {
        assignmentId: "asg-pm-2",
        expectedRunVersion: first.runVersion,
        targetAgent: "architect",
        objective: "design again",
        reason: "repeat without evidence",
        progressFingerprint: "same-fp",
        evidenceRefs: [],
        idempotencyKey: "loop-2",
        nextIdempotencyKey: "loop-2:next",
        auth: auth("pm"),
      },
    );

    expect(second.status).toBe("escalated");
    const asg = await store.getAssignment("asg-pm-2");
    expect(asg?.status).toBe("completed");
    const run = await store.getRun("run-1");
    expect(run?.status).toBe("needs-human");
    expect(run?.phase).toBe("needs-human");
    const outcomes = await store.listOutcomes("asg-pm-2");
    expect(outcomes.some((o) => o.action === "escalate")).toBe(true);
  });

  it("rejects system/human spoofing without trustedInternal", async () => {
    const store = new InMemoryPipelineStore(fakeClock(1000));
    await seedPmRun(store);

    const receipt = await requestHandoff(
      { store },
      {
        assignmentId: "asg-pm",
        expectedRunVersion: 0,
        targetAgent: "architect",
        objective: "spoof",
        reason: "spoof",
        progressFingerprint: "spoof-1",
        idempotencyKey: "spoof-1",
        nextIdempotencyKey: "spoof-1:next",
        auth: {
          agent: "system",
          channelId: "C1",
          threadId: "T1",
          // trustedInternal intentionally omitted
        },
      },
    );
    expect(receipt.status).toBe("rejected");
    expect(receipt.reason).toMatch(/not authorized/i);
  });

  it("rejects unauthorized edge with explicit receipt", async () => {
    const store = new InMemoryPipelineStore(fakeClock(1000));
    await seedPmRun(store);

    // PM may not hand off directly to review.
    const receipt = await requestHandoff(
      { store },
      {
        assignmentId: "asg-pm",
        expectedRunVersion: 0,
        targetAgent: "review",
        objective: "review code",
        reason: "unauthorized",
        progressFingerprint: "bad-edge",
        idempotencyKey: "handoff-bad",
        nextIdempotencyKey: "handoff-bad:next",
        auth: auth("pm"),
      },
    );

    expect(receipt.status).toBe("rejected");
    expect(receipt.reason).toMatch(/unauthorized handoff edge/i);

    const outbox = await store.listOutbox("run-1");
    expect(outbox).toHaveLength(0);
  });

  it("returns duplicate receipt for repeated idempotency key", async () => {
    const store = new InMemoryPipelineStore(fakeClock(1000));
    await seedPmRun(store);

    const first = await requestHandoff(
      { store },
      {
        assignmentId: "asg-pm",
        expectedRunVersion: 0,
        targetAgent: "architect",
        objective: "design",
        reason: "first",
        progressFingerprint: "dup-fp",
        idempotencyKey: "same-key",
        nextIdempotencyKey: "same-key:next",
        auth: auth("pm"),
      },
    );
    expect(first.status).toBe("accepted");

    const second = await requestHandoff(
      { store },
      {
        assignmentId: "asg-pm",
        expectedRunVersion: 1,
        targetAgent: "architect",
        objective: "design again",
        reason: "retry",
        progressFingerprint: "dup-fp-2",
        idempotencyKey: "same-key",
        nextIdempotencyKey: "same-key:next-2",
        auth: auth("pm"),
      },
    );
    expect(second.status).toBe("duplicate");
    expect(second.runVersion).toBe(1);
  });

  it("rejects outcome from wrong agent", async () => {
    const store = new InMemoryPipelineStore(fakeClock(1000));
    await seedPmRun(store);

    const receipt = await reportOutcome(
      { store },
      {
        outcome: {
          assignmentId: "asg-pm",
          expectedRunVersion: 0,
          action: "continue_self",
          status: "progress",
          reason: "working",
          evidenceRefs: ["e1"],
          artifactRefs: [],
          blockers: [],
          checks: [],
          progressFingerprint: "fp",
        },
        auth: auth("review"), // review does not own pm assignment
      },
    );

    expect(receipt.status).toBe("rejected");
    expect(receipt.reason).toMatch(/not authorized/i);
  });
});

describe("dispatch + busy buffer", () => {
  it("reports buffered when target agent is busy", async () => {
    const store = new InMemoryPipelineStore(fakeClock(1000));
    await store.createRun(makeProductRun({ ownerAgent: "pm", phase: "discovery" }));
    const assignment = await store.createAssignment(
      makeAssignmentCreate({
        id: "asg-arch",
        targetAgent: "architect",
        sourceAgent: "pm",
        objective: "design",
        idempotencyKey: "arch-1",
      }),
    );
    const run = (await store.getRun("run-1"))!;

    const dispatches: Array<{ agent: string; text: string; ts: string }> = [];
    const dispatcher = {
      handleAgentMessage: mock(async (event: SlackMessageEvent, agentName: string) => {
        dispatches.push({ agent: agentName, text: event.text, ts: event.ts });
      }),
    };

    const busySession: ThreadSession = createSession("T1", "C1");
    busySession.agentSessions = {
      architect: {
        agentName: "architect",
        sessionId: "s1",
        status: "busy",
        pendingMessages: [],
        lastActivity: Date.now(),
        pid: null,
        tmuxSessionName: null,
      },
    };

    const result = await dispatchAssignment(
      {
        dispatcher,
        sessionReader: {
          get: async () => busySession,
        },
      },
      { run, assignment, sourceMessageTs: "1700000000.000123" },
    );

    expect(result.status).toBe("buffered");
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]!.agent).toBe("architect");
    expect(dispatches[0]!.text).toContain("<pipeline-assignment>");
    expect(dispatches[0]!.ts).toBe("1700000000.000123");
  });

  it("reports dispatched when target is idle", async () => {
    const store = new InMemoryPipelineStore(fakeClock(1000));
    await store.createRun(makeProductRun({ ownerAgent: "pm", phase: "discovery" }));
    const assignment = await store.createAssignment(
      makeAssignmentCreate({
        id: "asg-arch",
        targetAgent: "architect",
        sourceAgent: "pm",
        objective: "design",
        idempotencyKey: "arch-1",
      }),
    );
    const run = (await store.getRun("run-1"))!;

    const result = await dispatchAssignment(
      {
        dispatcher: {
          handleAgentMessage: async () => undefined,
        },
        sessionReader: {
          get: async () => createSession("T1", "C1"),
        },
      },
      { run, assignment },
    );

    expect(result.status).toBe("dispatched");
  });

  it("keeps ordinary default-run dispatch audits out of Slack", async () => {
    const store = new InMemoryPipelineStore(fakeClock(1000));
    await store.createRun(makeDefaultRun());
    const assignment = await store.createAssignment(
      makeAssignmentCreate({
        id: "default-asg",
        runId: "default-run-1",
        targetAgent: "default",
        sourceAgent: "human",
        objective: "answer the user",
        idempotencyKey: "default-asg",
      }),
    );
    const run = (await store.getRun("default-run-1"))!;
    const audit = mock(async () => undefined);

    await dispatchAssignment(
      {
        dispatcher: { handleAgentMessage: async () => undefined },
        audit,
      },
      { run, assignment, sourceMessageTs: "1700000000.000789" },
    );

    expect(audit).not.toHaveBeenCalled();
  });
});

describe("outbox pump replay", () => {
  it("preserves the source Slack timestamp through the outbox dispatch", async () => {
    const clock = fakeClock(1000);
    const store = new InMemoryPipelineStore(clock);
    await seedPmRun(store);
    await store.enqueueOutbox({
      id: "source-ts-outbox",
      runId: "run-1",
      assignmentId: "asg-pm",
      eventType: "assignment.dispatch",
      payload: {
        assignmentId: "asg-pm",
        sourceMessageTs: "1700000000.000456",
      },
      idempotencyKey: "source-ts-outbox",
    });

    const events: SlackMessageEvent[] = [];
    await pumpOutbox({
      store,
      clock,
      dispatcher: {
        handleAgentMessage: async (event) => {
          events.push(event);
        },
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.ts).toBe("1700000000.000456");
  });

  it("uses per-resume human provenance instead of the assignment's original author", async () => {
    const clock = fakeClock(1000);
    const store = new InMemoryPipelineStore(clock);
    await seedPmRun(store);
    await store.enqueueOutbox({
      id: "speaker-b-resume",
      runId: "run-1",
      assignmentId: "asg-pm",
      eventType: "assignment.resume",
      payload: {
        assignmentId: "asg-pm",
        prompt: "Speaker B follow-up",
        sourceMessageTs: "1700000000.000999",
        sourceSlackUserId: "USPEAKERB",
      },
      idempotencyKey: "speaker-b-resume",
    });

    const events: SlackMessageEvent[] = [];
    await pumpOutbox({
      store,
      clock,
      dispatcher: {
        handleAgentMessage: async (event) => {
          events.push(event);
        },
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      user: "pipeline-internal",
      attributionUserId: "USPEAKERB",
      conversationalText: "Speaker B follow-up",
    });
  });

  it("replays undelivered dispatch after simulated crash between commit and mark", async () => {
    const clock = fakeClock(1000);
    const store = new InMemoryPipelineStore(clock);
    await seedPmRun(store);

    const receipt = await requestHandoff(
      { store },
      {
        assignmentId: "asg-pm",
        expectedRunVersion: 0,
        targetAgent: "architect",
        objective: "design",
        reason: "handoff",
        progressFingerprint: "pump-fp",
        idempotencyKey: "pump-1",
        nextIdempotencyKey: "pump-1:next",
        auth: auth("pm"),
      },
    );
    expect(receipt.status).toBe("accepted");

    // Simulate crash: outbox pending, never delivered.
    const pending = await store.listOutbox("run-1");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.status).toBe("pending");

    const wakes: string[] = [];
    const report = await pumpOutbox({
      store,
      clock,
      dispatcher: {
        handleAgentMessage: async (_e, agent) => {
          wakes.push(agent);
        },
      },
    });

    expect(report.delivered).toBe(1);
    expect(wakes).toEqual(["architect"]);

    const after = await store.listOutbox("run-1");
    expect(after[0]!.status).toBe("delivered");

    // Second pump must not re-dispatch delivered items.
    const report2 = await pumpOutbox({
      store,
      clock,
      dispatcher: {
        handleAgentMessage: async (_e, agent) => {
          wakes.push(agent);
        },
      },
    });
    expect(report2.claimed).toBe(0);
    expect(wakes).toEqual(["architect"]);
  });

  it("reclaims expired lease and delivers once", async () => {
    const clock = fakeClock(1000);
    const store = new InMemoryPipelineStore(clock);
    await seedPmRun(store);
    await requestHandoff(
      { store },
      {
        assignmentId: "asg-pm",
        expectedRunVersion: 0,
        targetAgent: "architect",
        objective: "design",
        reason: "handoff",
        progressFingerprint: "lease-fp",
        idempotencyKey: "lease-1",
        nextIdempotencyKey: "lease-1:next",
        auth: auth("pm"),
      },
    );

    // Claim under a dead owner, then expire the lease.
    const claimed = await store.claimOutbox("dead-worker", 10, 5_000);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.status).toBe("leased");

    clock.advance(10_000);

    const wakes: string[] = [];
    const report = await pumpOutbox({
      store,
      clock,
      owner: "live-worker",
      dispatcher: {
        handleAgentMessage: async (_e, agent) => {
          wakes.push(agent);
        },
      },
    });

    expect(report.reclaimed).toBe(1);
    expect(report.delivered).toBe(1);
    expect(wakes).toEqual(["architect"]);
  });
});

describe("delegated parent resume", () => {
  it("injects the completed child verdict so the parent does not wait again", async () => {
    const clock = fakeClock(1000);
    const store = new InMemoryPipelineStore(clock);
    await seedPmRun(store);

    const delegated = await requestHandoff(
      { store },
      {
        assignmentId: "asg-pm",
        expectedRunVersion: 0,
        targetAgent: "architect",
        objective: "review the plan",
        reason: "need a delegated verdict",
        progressFingerprint: "delegate-review",
        idempotencyKey: "delegate-review",
        nextIdempotencyKey: "delegate-review:child",
        action: "delegate",
        auth: auth("pm"),
      },
    );
    expect(delegated.status).toBe("accepted");
    const childAssignmentId = delegated.assignmentId;
    if (!childAssignmentId) throw new Error("delegation did not create a child");

    await pumpOutbox({
      store,
      clock,
      dispatcher: { handleAgentMessage: async () => undefined },
    });

    const completed = await reportOutcome(
      { store },
      {
        outcome: {
          assignmentId: childAssignmentId,
          expectedRunVersion: delegated.runVersion,
          action: "complete",
          status: "succeeded",
          reason: "Architecture review approved with no blockers",
          evidenceRefs: ["review:approved"],
          artifactRefs: ["artifact:plan"],
          blockers: [],
          checks: [{ name: "review", status: "passed", evidenceRef: "review:approved" }],
          progressFingerprint: "architect-approved",
        },
        idempotencyKey: "architect-approved",
        auth: auth("architect"),
      },
    );
    expect(completed.status).toBe("accepted");

    const resumes: SlackMessageEvent[] = [];
    await pumpOutbox({
      store,
      clock,
      dispatcher: {
        handleAgentMessage: async (event) => {
          resumes.push(event);
        },
      },
    });

    expect(resumes).toHaveLength(1);
    expect(resumes[0]!.text).toContain("<delegated-result>");
    expect(resumes[0]!.text).toContain("Architecture review approved with no blockers");
    expect(resumes[0]!.text).toContain("review:approved");
    expect(resumes[0]!.text).toContain(
      "do not wait for the same child again",
    );
    expect(resumes[0]!.ts).not.toBe("T1");
  });
});

describe("PR registration gate", () => {
  it("rejects PR-open completion without registration when github tracking enabled", async () => {
    const store = new InMemoryPipelineStore(fakeClock(1000));
    await store.createRun(
      makeProductRun({
        phase: "pr-open",
        ownerAgent: "build",
        stateVersion: 0,
      }),
    );
    await store.createAssignment(
      makeAssignmentCreate({
        id: "asg-build",
        targetAgent: "build",
        sourceAgent: "system",
        objective: "open PR",
        idempotencyKey: "build-pr-1",
      }),
    );

    const receipt = await reportOutcome(
      { store, githubTrackingEnabled: true },
      {
        outcome: {
          assignmentId: "asg-build",
          expectedRunVersion: 0,
          action: "complete",
          status: "succeeded",
          reason: "PR opened",
          evidenceRefs: [],
          artifactRefs: [],
          blockers: [],
          checks: [],
          progressFingerprint: "pr-done",
        },
        toPhase: "reviewing",
        auth: auth("build"),
      },
    );

    expect(receipt.status).toBe("rejected");
    expect(receipt.reason).toMatch(/registered PR/i);
  });

  it("accepts PR-open completion after registration when github tracking enabled", async () => {
    const store = new InMemoryPipelineStore(fakeClock(1000));
    await store.createRun(
      makeProductRun({
        phase: "pr-open",
        ownerAgent: "build",
        stateVersion: 0,
      }),
    );
    await store.createAssignment(
      makeAssignmentCreate({
        id: "asg-build",
        targetAgent: "build",
        sourceAgent: "system",
        objective: "open PR",
        idempotencyKey: "build-pr-1",
      }),
    );

    const reg = await registerPr(
      { store, githubTrackingEnabled: true },
      {
        runId: "run-1",
        assignmentId: "asg-build",
        owner: "org",
        repo: "backend",
        number: 42,
        role: "candidate",
        workstreamKey: "backend",
        attemptId: null,
        expectedHeadSha: "abc123",
      },
      auth("build"),
    );
    expect(reg.ok).toBe(true);

    const receipt = await reportOutcome(
      { store, githubTrackingEnabled: true },
      {
        outcome: {
          assignmentId: "asg-build",
          expectedRunVersion: 0,
          action: "complete",
          status: "succeeded",
          reason: "PR opened and registered",
          evidenceRefs: [],
          artifactRefs: [],
          blockers: [],
          checks: [],
          progressFingerprint: "pr-done",
        },
        toPhase: "reviewing",
        auth: auth("build"),
      },
    );

    expect(receipt.status).toBe("accepted");
    expect((await store.getRun("run-1"))?.phase).toBe("reviewing");
  });
});

describe("assignment context", () => {
  it("includes run and assignment anchors", async () => {
    const store = new InMemoryPipelineStore(fakeClock(1000));
    await seedPmRun(store);
    const run = (await store.getRun("run-1"))!;
    const assignment = (await store.getAssignment("asg-pm"))!;
    const block = buildAssignmentContext({ run, assignment });
    expect(block).toContain("<pipeline-assignment>");
    expect(block).toContain("run_id: run-1");
    expect(block).toContain("assignment_id: asg-pm");
    expect(block).toContain("target_agent: pm");
    expect(block).toContain("phase: discovery");
  });
});

describe("artifacts and checks", () => {
  it("writes only under pipeline-owned paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipeline-art-"));
    try {
      const ok = await writePipelineArtifact({
        runId: "run-1",
        relativePath: "notes/spec.md",
        content: "# spec\n",
        rootDir: root,
      });
      expect(ok.ok).toBe(true);
      if (ok.ok) {
        expect(ok.artifactRef).toBe("data/pipelines/run-1/notes/spec.md");
      }

      const bad = resolvePipelineArtifactPath({
        runId: "run-1",
        relativePath: "../escape.txt",
        rootDir: root,
      });
      expect(bad.ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects non-allowlisted checks", async () => {
    const result = await runPipelineCheck({
      runId: "run-1",
      assignmentId: "asg-1",
      checkName: "rm -rf /",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/not allowlisted/i);
    }
  });

  it("records stub evidence for allowlisted checks", async () => {
    const root = mkdtempSync(join(tmpdir(), "pipeline-check-"));
    try {
      const result = await runPipelineCheck({
        runId: "run-1",
        assignmentId: "asg-1",
        checkName: "typecheck",
        status: "passed",
        rootDir: root,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.check.status).toBe("passed");
        expect(result.check.evidenceRef).toContain("data/pipelines/run-1/checks/");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("MCP tool runtime mode=off", () => {
  it("get_state still works (empty) when mode=off", async () => {
    const store = new InMemoryPipelineStore(fakeClock(1000));
    const runtime: PipelineToolRuntime = {
      store,
      runtimeMode: "off",
      githubTrackingEnabled: false,
    };
    const result = await pipelineGetState(
      runtime,
      { agent: "pm", channel: "C1", threadId: "T1", signed: true },
      {},
    );
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.ok).toBe(true);
    expect(payload.run).toBeNull();
    expect(payload.runtimeMode).toBe("off");
  });

  it("request_handoff returns disabled when mode=off", async () => {
    const store = new InMemoryPipelineStore(fakeClock(1000));
    await seedPmRun(store);
    const runtime: PipelineToolRuntime = {
      store,
      runtimeMode: "off",
      githubTrackingEnabled: false,
    };
    const result = await pipelineRequestHandoff(
      runtime,
      { agent: "pm", channel: "C1", threadId: "T1", signed: true },
      {
        assignment_id: "asg-pm",
        expected_run_version: 0,
        target_agent: "architect",
        objective: "design",
        reason: "need arch",
        progress_fingerprint: "fp",
        idempotency_key: "k1",
      },
    );
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.reason).toMatch(/pipeline runtime disabled/i);
  });
});
