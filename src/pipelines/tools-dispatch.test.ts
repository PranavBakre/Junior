import { describe, expect, it } from "bun:test";
import { createSession } from "../session/types.ts";
import { InMemorySessionStore } from "../session/store/memory.ts";
import { createDefaultRun } from "./default/controller.ts";
import { InMemoryPipelineStore } from "./store/memory.ts";
import {
  pipelineDispatchAgent,
  pipelineReportOutcome,
  type PipelineToolRuntime,
  type ToolTextResult,
} from "./tools.ts";
import { makeAssignmentCreate, makeProductRun } from "./store/test-helpers.ts";

const THREAD = "1700000000.100";
const CHANNEL = "C-DISPATCH";

function body(result: ToolTextResult): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
}

describe("durable agent_dispatch", () => {
  it("delegates from the authenticated assignment and resumes its parent", async () => {
    const store = new InMemoryPipelineStore();
    const sessions = new InMemorySessionStore();
    const session = createSession(THREAD, CHANNEL);
    session.activeAgentName = "default";
    await sessions.set(THREAD, session);
    const started = await createDefaultRun(
      { store },
      {
        channelId: CHANNEL,
        threadId: THREAD,
        objective: "review the implementation and continue",
        messageTs: "1700000000.101",
        targetAgent: "default",
        repoRefs: ["junior"],
      },
    );
    await sessions.mutateThread(THREAD, (current) => {
      current.activeRunId = started.run.id;
      current.activePipelineInvocation = {
        runId: started.run.id,
        assignmentId: started.assignment.id,
        dispatchKey: "default-dispatch",
        outcomeCountAtDispatch: 0,
        retryCount: 0,
      };
    });
    const runtime: PipelineToolRuntime = {
      store,
      sessionStore: sessions,
      runtimeMode: "active",
      githubTrackingEnabled: false,
    };
    const context = {
      agent: "default",
      channel: CHANNEL,
      threadId: THREAD,
      messageTs: "1700000000.101",
      runId: started.run.id,
      assignmentId: started.assignment.id,
      dispatchKey: "default-dispatch",
      signed: true,
    } as const;

    const dispatched = body(await pipelineDispatchAgent(runtime, context, {
      target_agent: "review",
      objective: "Review PR 123 and report a typed verdict",
      mode: "delegate",
      reason: "independent review is needed before continuing",
      idempotency_key: "delegate-review-pr-123",
    }));
    expect(dispatched.ok).toBe(true);
    const childId = dispatched.targetAssignmentId as string;
    expect(await store.getAssignment(started.assignment.id)).toMatchObject({ status: "waiting" });
    expect(await store.getAssignment(childId)).toMatchObject({
      targetAgent: "review",
      parentAssignmentId: started.assignment.id,
    });
    const replay = body(await pipelineDispatchAgent(runtime, context, {
      target_agent: "review",
      objective: "Review PR 123 and report a typed verdict",
      mode: "delegate",
      reason: "independent review is needed before continuing",
      idempotency_key: "delegate-review-pr-123",
    }));
    expect((replay.receipt as { status: string }).status).toBe("duplicate");
    expect(replay.targetAssignmentId).toBe(childId);

    const run = await store.getRun(started.run.id);
    const completed = await store.recordOutcomeTransaction({
      outcome: {
        assignmentId: childId,
        expectedRunVersion: run!.stateVersion,
        action: "complete",
        status: "succeeded",
        reason: "review approved",
        evidenceRefs: ["github-review:123"],
        artifactRefs: [],
        blockers: [],
        checks: [],
        progressFingerprint: "review-approved-123",
      },
      actorType: "agent",
      actorId: "review",
      idempotencyKey: "review-approved-123",
    });
    expect(completed.status).toBe("accepted");
    expect(await store.getAssignment(started.assignment.id)).toMatchObject({ status: "pending" });
    expect((await store.listOutbox(started.run.id)).at(-1)).toMatchObject({
      eventType: "assignment.resume",
      assignmentId: started.assignment.id,
    });
  });

  it("rejects worktree dispatch before committing when no repository is bound", async () => {
    const store = new InMemoryPipelineStore();
    const sessions = new InMemorySessionStore();
    const started = await createDefaultRun(
      { store },
      {
        channelId: CHANNEL,
        threadId: THREAD,
        objective: "scope then build",
        messageTs: "1700000000.104",
        targetAgent: "default",
      },
    );
    const session = createSession(THREAD, CHANNEL);
    session.activePipelineInvocation = {
      runId: started.run.id,
      assignmentId: started.assignment.id,
      dispatchKey: "repo-less-dispatch",
      outcomeCountAtDispatch: 0,
      retryCount: 0,
    };
    await sessions.set(THREAD, session);

    const result = body(await pipelineDispatchAgent({
      store,
      sessionStore: sessions,
      runtimeMode: "active",
      githubTrackingEnabled: false,
    }, {
      agent: "default",
      channel: CHANNEL,
      threadId: THREAD,
      runId: started.run.id,
      assignmentId: started.assignment.id,
      dispatchKey: "repo-less-dispatch",
      signed: true,
    }, {
      target_agent: "build",
      objective: "Implement the scoped change",
      mode: "delegate",
      reason: "The plan is ready",
      idempotency_key: "repo-less-build",
    }));

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("retry agent_dispatch with repo_refs");
    expect(await store.getRun(started.run.id)).toMatchObject({
      phase: "working",
      status: "active",
      repoRefs: [],
      stateVersion: 0,
    });
    expect(await store.getAssignment(started.assignment.id)).toMatchObject({
      status: "pending",
    });
    expect(await store.listAssignments(started.run.id)).toHaveLength(1);
  });

  it("binds a missing repository and resumes a needs-human run atomically", async () => {
    const store = new InMemoryPipelineStore();
    const sessions = new InMemorySessionStore();
    const started = await createDefaultRun(
      { store },
      {
        channelId: CHANNEL,
        threadId: THREAD,
        objective: "scope then build",
        messageTs: "1700000000.105",
        targetAgent: "default",
      },
    );
    const escalated = await store.recordOutcomeTransaction({
      outcome: {
        assignmentId: started.assignment.id,
        expectedRunVersion: started.run.stateVersion,
        action: "escalate",
        status: "blocked",
        reason: "Repository was missing",
        evidenceRefs: [],
        artifactRefs: [],
        blockers: [{ kind: "infra_failure", detail: "No repository bound" }],
        checks: [],
        progressFingerprint: "missing-repository",
      },
      toPhase: "needs-human",
      actorType: "system",
      actorId: "pipeline-settlement",
      idempotencyKey: "missing-repository",
    });
    expect(escalated.status).toBe("escalated");

    const recovery = await store.createAssignment(makeAssignmentCreate({
      id: "human-recovery",
      runId: started.run.id,
      parentAssignmentId: started.assignment.id,
      sourceAgent: "human",
      targetAgent: "default",
      objective: "Retry in gx-backend",
      contextRefs: ["control-branch:human-input"],
      idempotencyKey: "human-recovery",
    }));
    const session = createSession(THREAD, CHANNEL);
    session.activePipelineInvocation = {
      runId: started.run.id,
      assignmentId: recovery.id,
      dispatchKey: "human-recovery-dispatch",
      outcomeCountAtDispatch: 0,
      retryCount: 0,
    };
    await sessions.set(THREAD, session);

    const result = body(await pipelineDispatchAgent({
      store,
      sessionStore: sessions,
      runtimeMode: "active",
      githubTrackingEnabled: false,
      repos: [{
        name: "gx-backend",
        path: "/tmp/gx-backend",
        defaultBase: "origin/main",
      }],
    }, {
      agent: "default",
      channel: CHANNEL,
      threadId: THREAD,
      runId: started.run.id,
      assignmentId: recovery.id,
      dispatchKey: "human-recovery-dispatch",
      signed: true,
    }, {
      target_agent: "build",
      objective: "Implement the scoped change in gx-backend",
      mode: "handoff",
      reason: "The user supplied the missing repository",
      idempotency_key: "recover-with-repo",
      repo_refs: ["GrowthX-Club/gx-backend"],
    }));

    expect(result.ok).toBe(true);
    expect(result.recovered).toBe(true);
    expect(await store.getRun(started.run.id)).toMatchObject({
      phase: "working",
      status: "active",
      repoRefs: ["GrowthX-Club/gx-backend"],
      stateVersion: 2,
    });
    expect(await store.getAssignment(recovery.id)).toMatchObject({
      status: "completed",
    });
    expect(await store.getAssignment(result.targetAssignmentId as string))
      .toMatchObject({
        targetAgent: "build",
        status: "pending",
      });
  });

  it("rejects dispatch when the signed caller does not own the assignment", async () => {
    const store = new InMemoryPipelineStore();
    const sessions = new InMemorySessionStore();
    const session = createSession(THREAD, CHANNEL);
    await sessions.set(THREAD, session);
    const started = await createDefaultRun(
      { store },
      {
        channelId: CHANNEL,
        threadId: THREAD,
        objective: "build it",
        messageTs: "1700000000.102",
        targetAgent: "build",
      },
    );
    await sessions.mutateThread(THREAD, (current) => {
      current.agentSessions.review = {
        agentName: "review",
        provider: "claude",
        sessionId: null,
        sessionCwd: null,
        status: "busy",
        pendingMessages: [],
        lastActivity: Date.now(),
        pid: null,
        activePipelineInvocation: {
          runId: started.run.id,
          assignmentId: started.assignment.id,
          dispatchKey: "forged",
          outcomeCountAtDispatch: 0,
          retryCount: 0,
        },
      };
    });
    const result = body(await pipelineDispatchAgent(
      {
        store,
        sessionStore: sessions,
        runtimeMode: "active",
        githubTrackingEnabled: false,
      },
      {
        agent: "review",
        channel: CHANNEL,
        threadId: THREAD,
        runId: started.run.id,
        assignmentId: started.assignment.id,
        dispatchKey: "forged",
        signed: true,
      },
      {
        target_agent: "frontend",
        objective: "change code",
        mode: "handoff",
        reason: "forged",
        idempotency_key: "forged",
      },
    ));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("does not own");
  });

  it("keeps typed controller phase neutral while a delegated child completes", async () => {
    const store = new InMemoryPipelineStore();
    const sessions = new InMemorySessionStore();
    await store.createRun(makeProductRun({
      id: "product-run",
      threadId: THREAD,
      channelId: CHANNEL,
      phase: "building",
    }));
    const source = await store.createAssignment(makeAssignmentCreate({
      id: "build-source",
      runId: "product-run",
      targetAgent: "build",
      idempotencyKey: "build-source-key",
    }));
    const session = createSession(THREAD, CHANNEL);
    session.agentSessions.build = {
      agentName: "build",
      provider: "claude",
      sessionId: null,
      sessionCwd: null,
      status: "busy",
      pendingMessages: [],
      lastActivity: Date.now(),
      pid: null,
      activePipelineInvocation: {
        runId: "product-run",
        assignmentId: source.id,
        dispatchKey: "build-dispatch",
        outcomeCountAtDispatch: 0,
        retryCount: 0,
      },
    };
    await sessions.set(THREAD, session);
    const runtime: PipelineToolRuntime = {
      store,
      sessionStore: sessions,
      runtimeMode: "active",
      githubTrackingEnabled: false,
    };
    const delegated = body(await pipelineDispatchAgent(runtime, {
      agent: "build",
      channel: CHANNEL,
      threadId: THREAD,
      runId: "product-run",
      assignmentId: source.id,
      dispatchKey: "build-dispatch",
      signed: true,
    }, {
      target_agent: "review",
      objective: "Review the candidate without advancing the controller",
      mode: "delegate",
      reason: "builder needs an independent check before continuing",
      idempotency_key: "delegate-product-review",
    }));
    const childId = delegated.targetAssignmentId as string;
    await sessions.mutateThread(THREAD, (current) => {
      current.agentSessions.review = {
        agentName: "review",
        provider: "claude",
        sessionId: null,
        sessionCwd: null,
        status: "busy",
        pendingMessages: [],
        lastActivity: Date.now(),
        pid: null,
        activePipelineInvocation: {
          runId: "product-run",
          assignmentId: childId,
          dispatchKey: "review-dispatch",
          outcomeCountAtDispatch: 0,
          retryCount: 0,
        },
      };
    });
    const currentRun = await store.getRun("product-run");
    const completed = body(await pipelineReportOutcome(runtime, {
      agent: "review",
      channel: CHANNEL,
      threadId: THREAD,
      runId: "product-run",
      assignmentId: childId,
      dispatchKey: "review-dispatch",
      signed: true,
    }, {
      outcome: {
        assignmentId: childId,
        expectedRunVersion: currentRun!.stateVersion,
        action: "complete",
        status: "succeeded",
        reason: "review complete",
        evidenceRefs: ["review:approved"],
        artifactRefs: [],
        blockers: [],
        checks: [],
        progressFingerprint: "product-review-complete",
      },
      idempotency_key: "product-review-complete",
    }));

    expect(completed.ok).toBe(true);
    expect(await store.getRun("product-run")).toMatchObject({ phase: "building" });
    expect(await store.getAssignment(source.id)).toMatchObject({ status: "pending" });
  });

  it("rejects a phase advance attached to delegate mode", async () => {
    const store = new InMemoryPipelineStore();
    const sessions = new InMemorySessionStore();
    const started = await createDefaultRun(
      { store },
      {
        channelId: CHANNEL,
        threadId: THREAD,
        objective: "review and continue",
        messageTs: "1700000000.103",
        targetAgent: "default",
      },
    );
    const session = createSession(THREAD, CHANNEL);
    session.activePipelineInvocation = {
      runId: started.run.id,
      assignmentId: started.assignment.id,
      dispatchKey: "default-dispatch",
      outcomeCountAtDispatch: 0,
      retryCount: 0,
    };
    await sessions.set(THREAD, session);
    const runtime: PipelineToolRuntime = {
      store,
      sessionStore: sessions,
      runtimeMode: "active",
      githubTrackingEnabled: false,
    };
    const context = {
      agent: "default",
      channel: CHANNEL,
      threadId: THREAD,
      runId: started.run.id,
      assignmentId: started.assignment.id,
      dispatchKey: "default-dispatch",
      signed: true,
    } as const;
    const result = await pipelineDispatchAgent(runtime, context, {
      target_agent: "review",
      objective: "Review the change",
      mode: "delegate",
      reason: "Need an independent review",
      idempotency_key: "delegate-with-phase",
      to_phase: "reviewing",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("delegate is phase-neutral");
  });
});
