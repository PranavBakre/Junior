/**
 * Authenticated outcomes, handoffs, outbox pump, and PR registration gate.
 */
import { describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeClock } from "../time/clock.ts";
import { InMemoryPipelineStore } from "./store/memory.ts";
import { makeAssignmentCreate, makeProductRun } from "./store/test-helpers.ts";
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

    const dispatches: Array<{ agent: string; text: string }> = [];
    const dispatcher = {
      handleAgentMessage: mock(async (event: SlackMessageEvent, agentName: string) => {
        dispatches.push({ agent: agentName, text: event.text });
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
      { run, assignment },
    );

    expect(result.status).toBe("buffered");
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]!.agent).toBe("architect");
    expect(dispatches[0]!.text).toContain("<pipeline-assignment>");
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
});

describe("outbox pump replay", () => {
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
      { agent: "pm", channel: "C1", threadId: "T1" },
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
      { agent: "pm", channel: "C1", threadId: "T1" },
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
