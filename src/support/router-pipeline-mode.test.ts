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
});
