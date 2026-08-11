/**
 * Prove PIPELINE_RUNTIME_MODE=off leaves existing Slack directive routing unchanged,
 * and active mode + active run takes the typed legacy-directive path.
 */
import { describe, expect, it, mock } from "bun:test";
import type { SlackMessageEvent } from "../slack/events.ts";
import { AgentDispatcher } from "./router.ts";
import { InMemoryPipelineStore } from "../pipelines/store/memory.ts";
import { fakeClock } from "../time/clock.ts";
import {
  makeAssignmentCreate,
  makeProductRun,
} from "../pipelines/store/test-helpers.ts";
import { pipelineReportOutcome } from "../pipelines/tools.ts";
import { createSession } from "../session/types.ts";
import type { SessionStore } from "../session/store/interface.ts";
import type { ThreadSession } from "../session/types.ts";

function makeEvent(overrides: Partial<SlackMessageEvent> = {}): SlackMessageEvent {
  return {
    threadId: "thread-1",
    channel: "CBUGS",
    user: "U123",
    text: "hello",
    ts: "123.456",
    command: null,
    ...overrides,
  };
}

function memorySessionStore(
  sessions: Map<string, ThreadSession>,
): SessionStore {
  return {
    get: async (id: string) => sessions.get(id),
    set: async (id: string, s: ThreadSession) => {
      sessions.set(id, s);
    },
    delete: async (id: string) => {
      sessions.delete(id);
    },
    getAll: async () => new Map(sessions),
    getRecent: async () => new Map(sessions),
    updateActivity: async () => undefined,
    extraAdmins: async () => new Set<string>(),
    mutateThread: async (
      id: string,
      mutator: (session: ThreadSession) => ThreadSession | void,
    ) => {
      const s = sessions.get(id);
      if (!s) throw new Error(`missing session ${id}`);
      mutator(s);
      return s;
    },
    mutateAgent: async () => {
      throw new Error("not implemented");
    },
    removeAgentSession: async (id: string, agentName: string) => {
      const s = sessions.get(id);
      if (s?.agentSessions?.[agentName]) {
        delete s.agentSessions[agentName];
      }
    },
  };
}

describe("AgentDispatcher pipeline mode soft integration", () => {
  it("mode=off: !review still dispatches via handleAgentMessage (legacy path)", async () => {
    const handleAgentMessage = mock(
      async (_event: SlackMessageEvent, _agent: string) => {},
    );
    const manager = {
      handleAgentMessage,
      handleLeadMessage: mock(async () => {}),
      handleMessage: mock(async () => {}),
    };

    const dispatcher = new AgentDispatcher(
      manager as never,
      new Set(["CBUGS"]),
      {
        pipeline: {
          store: new InMemoryPipelineStore(fakeClock(1000)),
          runtimeMode: "off",
          legacyDirectivesEnabled: true,
        },
      },
    );

    await dispatcher.handleMessage(
      makeEvent({
        text: "!review please review the PR",
        isSelfBot: true,
        botUsername: "Junior",
      }),
    );

    expect(handleAgentMessage).toHaveBeenCalledTimes(1);
    expect(handleAgentMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "please review the PR",
      }),
      "review",
    );
  });

  it("mode=off with activePipelineRunId still uses legacy path (mode gate)", async () => {
    const handleAgentMessage = mock(
      async (_event: SlackMessageEvent, _agent: string) => {},
    );
    const sessions = new Map<string, ThreadSession>();
    const session = createSession("thread-1", "CBUGS");
    session.activePipelineRunId = "run-1";
    session.activePipelineKind = "product";
    sessions.set("thread-1", session);

    const pipelineStore = new InMemoryPipelineStore(fakeClock(1000));
    await pipelineStore.createRun(
      makeProductRun({
        id: "run-1",
        threadId: "thread-1",
        channelId: "CBUGS",
        phase: "building",
        ownerAgent: "default",
      }),
    );
    await pipelineStore.createAssignment(
      makeAssignmentCreate({
        id: "asg-1",
        runId: "run-1",
        targetAgent: "default",
        sourceAgent: "system",
        idempotencyKey: "asg-1",
      }),
    );

    const dispatcher = new AgentDispatcher(
      {
        handleAgentMessage,
        handleLeadMessage: mock(async () => {}),
        handleMessage: mock(async () => {}),
      } as never,
      new Set(["CBUGS"]),
      {
        sessionStore: memorySessionStore(sessions),
        pipeline: {
          store: pipelineStore,
          runtimeMode: "off",
          legacyDirectivesEnabled: true,
        },
      },
    );

    await dispatcher.handleMessage(
      makeEvent({
        text: "!review check this",
        isSelfBot: true,
        botUsername: "Junior",
      }),
    );

    // Legacy path — not converted to pipeline handoff.
    expect(handleAgentMessage).toHaveBeenCalledTimes(1);
    expect(handleAgentMessage.mock.calls[0]![1]).toBe("review");
    const outbox = await pipelineStore.listOutbox("run-1");
    expect(outbox).toHaveLength(0);
  });

  it("mode=active + active run converts !review into typed handoff + pump", async () => {
    const handleAgentMessage = mock(
      async (_event: SlackMessageEvent, _agent: string) => {},
    );
    const sessions = new Map<string, ThreadSession>();
    const session = createSession("thread-1", "CBUGS");
    session.activePipelineRunId = "run-1";
    session.activePipelineKind = "product";
    sessions.set("thread-1", session);

    const pipelineStore = new InMemoryPipelineStore(fakeClock(1000));
    await pipelineStore.createRun(
      makeProductRun({
        id: "run-1",
        threadId: "thread-1",
        channelId: "CBUGS",
        phase: "building",
        ownerAgent: "default",
      }),
    );
    await pipelineStore.createAssignment(
      makeAssignmentCreate({
        id: "asg-orch",
        runId: "run-1",
        targetAgent: "default",
        sourceAgent: "system",
        objective: "orchestrate",
        idempotencyKey: "asg-orch",
      }),
    );

    const dispatcher = new AgentDispatcher(
      {
        handleAgentMessage,
        handleLeadMessage: mock(async () => {}),
        handleMessage: mock(async () => {}),
      } as never,
      new Set(["CBUGS"]),
      {
        sessionStore: memorySessionStore(sessions),
        pipeline: {
          store: pipelineStore,
          runtimeMode: "active",
          legacyDirectivesEnabled: true,
        },
      },
    );

    await dispatcher.handleMessage(
      makeEvent({
        text: "!review check this PR",
        isSelfBot: true,
        botUsername: "Junior",
      }),
    );

    // Typed path: handoff committed + pump dispatches review via manager.
    const assignments = await pipelineStore.listAssignments("run-1");
    expect(assignments.some((a) => a.targetAgent === "review")).toBe(true);

    const outbox = await pipelineStore.listOutbox("run-1");
    expect(outbox.some((o) => o.status === "delivered")).toBe(true);

    expect(handleAgentMessage).toHaveBeenCalled();
    const agents = handleAgentMessage.mock.calls.map((c) => c[1]);
    expect(agents).toContain("review");
  });

  it("does not swallow a rejected typed handoff from a waiting bot assignment", async () => {
    const handleAgentMessage = mock(
      async (_event: SlackMessageEvent, _agent: string) => {},
    );
    const sessions = new Map<string, ThreadSession>();
    const session = createSession("thread-1", "CBUGS");
    session.activePipelineRunId = "run-1";
    session.activePipelineKind = "product";
    sessions.set("thread-1", session);

    const pipelineStore = new InMemoryPipelineStore(fakeClock(1000));
    await pipelineStore.createRun(
      makeProductRun({
        id: "run-1",
        threadId: "thread-1",
        channelId: "CBUGS",
        phase: "needs-human",
        status: "needs-human",
        ownerAgent: "default",
      }),
    );
    await pipelineStore.createAssignment(
      makeAssignmentCreate({
        id: "asg-waiting",
        runId: "run-1",
        targetAgent: "default",
        status: "waiting",
        idempotencyKey: "asg-waiting",
      }),
    );

    const dispatcher = new AgentDispatcher(
      {
        handleAgentMessage,
        handleLeadMessage: mock(async () => {}),
        handleMessage: mock(async () => {}),
      } as never,
      new Set(["CBUGS"]),
      {
        sessionStore: memorySessionStore(sessions),
        pipeline: {
          store: pipelineStore,
          runtimeMode: "active",
          legacyDirectivesEnabled: true,
        },
      },
    );

    await dispatcher.handleMessage(
      makeEvent({
        text: "!review re-review",
        isSelfBot: false,
        botId: "BFOREIGN",
        botUsername: "Automation",
      }),
    );

    expect(handleAgentMessage).toHaveBeenCalledTimes(1);
    expect(handleAgentMessage.mock.calls[0]![1]).toBe("review");
    expect(
      (await pipelineStore.listAssignments("run-1")).filter(
        (assignment) => assignment.targetAgent === "review",
      ),
    ).toHaveLength(0);
  });

  it("does not let a bot directive resume a needs-human product run", async () => {
    const handleAgentMessage = mock(
      async (_event: SlackMessageEvent, _agent: string) => {},
    );
    const sessions = new Map<string, ThreadSession>();
    const session = createSession("thread-1", "CBUGS");
    session.activePipelineRunId = "run-1";
    session.activePipelineKind = "product";
    sessions.set("thread-1", session);

    const pipelineStore = new InMemoryPipelineStore(fakeClock(1000));
    await pipelineStore.createRun(
      makeProductRun({
        id: "run-1",
        threadId: "thread-1",
        channelId: "CBUGS",
        phase: "needs-human",
        status: "needs-human",
        ownerAgent: "default",
      }),
    );
    await pipelineStore.createAssignment(
      makeAssignmentCreate({
        id: "asg-open",
        runId: "run-1",
        targetAgent: "default",
        status: "leased",
        idempotencyKey: "asg-open",
      }),
    );

    const dispatcher = new AgentDispatcher(
      {
        handleAgentMessage,
        handleLeadMessage: mock(async () => {}),
        handleMessage: mock(async () => {}),
      } as never,
      new Set(["CBUGS"]),
      {
        sessionStore: memorySessionStore(sessions),
        pipeline: {
          store: pipelineStore,
          runtimeMode: "active",
          legacyDirectivesEnabled: true,
        },
      },
    );

    await dispatcher.handleMessage(
      makeEvent({
        text: "!review re-review",
        isSelfBot: true,
        botUsername: "Junior",
      }),
    );

    expect(await pipelineStore.getRun("run-1")).toMatchObject({
      phase: "needs-human",
      status: "needs-human",
      stateVersion: 0,
    });
    expect(
      (await pipelineStore.listAssignments("run-1")).filter(
        (assignment) => assignment.targetAgent === "review",
      ),
    ).toHaveLength(0);
    expect(handleAgentMessage.mock.calls.map((call) => call[1])).toEqual([
      "review",
    ]);
  });

  it("falls back only rejected siblings from a mixed directive message", async () => {
    const handleAgentMessage = mock(
      async (_event: SlackMessageEvent, _agent: string) => {},
    );
    const sessions = new Map<string, ThreadSession>();
    const session = createSession("thread-1", "CBUGS");
    session.activePipelineRunId = "run-1";
    session.activePipelineKind = "product";
    sessions.set("thread-1", session);

    const pipelineStore = new InMemoryPipelineStore(fakeClock(1000));
    await pipelineStore.createRun(
      makeProductRun({
        id: "run-1",
        threadId: "thread-1",
        channelId: "CBUGS",
        phase: "building",
        ownerAgent: "default",
      }),
    );
    await pipelineStore.createAssignment(
      makeAssignmentCreate({
        id: "asg-orch",
        runId: "run-1",
        targetAgent: "default",
        sourceAgent: "system",
        idempotencyKey: "asg-orch",
      }),
    );

    const dispatcher = new AgentDispatcher(
      {
        handleAgentMessage,
        handleLeadMessage: mock(async () => {}),
        handleMessage: mock(async () => {}),
      } as never,
      new Set(["CBUGS"]),
      {
        sessionStore: memorySessionStore(sessions),
        pipeline: {
          store: pipelineStore,
          runtimeMode: "active",
          legacyDirectivesEnabled: true,
        },
      },
    );

    await dispatcher.handleMessage(
      makeEvent({
        text: "!review check the PR\n!reproducer verify the behavior",
        isSelfBot: true,
        botUsername: "Junior",
      }),
    );

    const assignments = await pipelineStore.listAssignments("run-1");
    expect(
      assignments.filter((assignment) => assignment.targetAgent === "review"),
    ).toHaveLength(1);
    expect(
      assignments.filter(
        (assignment) => assignment.targetAgent === "reproducer",
      ),
    ).toHaveLength(0);
    const agents = handleAgentMessage.mock.calls.map((call) => call[1]);
    expect(agents.filter((agent) => agent === "review")).toHaveLength(1);
    expect(agents.filter((agent) => agent === "reproducer")).toHaveLength(1);
  });

  it("resumes a needs-human product run for a human !review re-review", async () => {
    const handleAgentMessage = mock(
      async (_event: SlackMessageEvent, _agent: string) => {},
    );
    const sessions = new Map<string, ThreadSession>();
    const session = createSession("thread-1", "CBUGS");
    session.activePipelineRunId = "run-1";
    session.activePipelineKind = "product";
    sessions.set("thread-1", session);

    const pipelineStore = new InMemoryPipelineStore(fakeClock(1000));
    await pipelineStore.createRun(
      makeProductRun({
        id: "run-1",
        threadId: "thread-1",
        channelId: "CBUGS",
        phase: "needs-human",
        status: "needs-human",
        ownerAgent: "default",
      }),
    );
    await pipelineStore.createAssignment(
      makeAssignmentCreate({
        id: "asg-waiting",
        runId: "run-1",
        targetAgent: "default",
        status: "waiting",
        idempotencyKey: "asg-waiting",
      }),
    );

    const dispatcher = new AgentDispatcher(
      {
        handleAgentMessage,
        handleLeadMessage: mock(async () => {}),
        handleMessage: mock(async () => {}),
      } as never,
      new Set(["CBUGS"]),
      {
        sessionStore: memorySessionStore(sessions),
        pipeline: {
          store: pipelineStore,
          runtimeMode: "active",
          legacyDirectivesEnabled: true,
        },
      },
    );

    await dispatcher.handleMessage(
      makeEvent({ text: "!review re-review", isSelfBot: false }),
    );

    expect(await pipelineStore.getRun("run-1")).toMatchObject({
      phase: "reviewing",
      status: "active",
    });
    const assignments = await pipelineStore.listAssignments("run-1");
    const control = assignments.find((assignment) =>
      assignment.contextRefs.includes("human-directive:123.456")
    );
    expect(control).toMatchObject({
      sourceAgent: "human",
      targetAgent: "default",
      status: "completed",
      parentAssignmentId: "asg-waiting",
    });
    expect(assignments).toContainEqual(
      expect.objectContaining({
        targetAgent: "review",
        parentAssignmentId: control?.id,
      }),
    );
    const review = assignments.find(
      (assignment) => assignment.targetAgent === "review",
    );
    if (!review) throw new Error("missing review assignment");
    expect(handleAgentMessage.mock.calls.map((call) => call[1])).toContain(
      "review",
    );

    session.agentSessions.review = {
      agentName: "review",
      provider: "claude",
      sessionId: null,
      sessionCwd: null,
      status: "busy",
      pendingMessages: [],
      lastActivity: Date.now(),
      pid: null,
      activePipelineInvocation: {
        runId: "run-1",
        assignmentId: review.id,
        dispatchKey: "review-dispatch",
        outcomeCountAtDispatch: 0,
        retryCount: 0,
      },
    };
    const reviewingRun = await pipelineStore.getRun("run-1");
    const result = await pipelineReportOutcome(
      {
        store: pipelineStore,
        sessionStore: memorySessionStore(sessions),
        runtimeMode: "active",
        githubTrackingEnabled: false,
      },
      {
        agent: "review",
        channel: "CBUGS",
        threadId: "thread-1",
        runId: "run-1",
        assignmentId: review.id,
        dispatchKey: "review-dispatch",
        signed: true,
      },
      {
        outcome: {
          assignmentId: review.id,
          expectedRunVersion: reviewingRun!.stateVersion,
          action: "complete",
          status: "failed",
          reason: "changes requested",
          evidenceRefs: ["review:changes-requested"],
          artifactRefs: [],
          blockers: [],
          checks: [{ name: "review", status: "failed" }],
          progressFingerprint: "review-findings-v2",
        },
        idempotency_key: "review-outcome-v2",
      },
    );

    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ ok: true });
    expect(await pipelineStore.getRun("run-1")).toMatchObject({
      phase: "fixing",
      status: "active",
    });
  });
});
