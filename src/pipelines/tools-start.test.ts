import { describe, expect, it } from "bun:test";
import { createSession } from "../session/types.ts";
import { InMemorySessionStore } from "../session/store/memory.ts";
import type { SessionStore } from "../session/store/interface.ts";
import type { PipelineStore } from "./store/interface.ts";
import { InMemoryPipelineStore } from "./store/memory.ts";
import { pumpOutbox } from "./pump.ts";
import {
  pipelineStartRun,
  type PipelineStartRunArgs,
  type PipelineToolRuntime,
  type ToolTextResult,
} from "./tools.ts";

const THREAD = "1711111111.000001";
const CHANNEL = "C-PIPELINE";

function payload(result: ToolTextResult): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
}

function context(agent = "default") {
  return {
    agent,
    channel: CHANNEL,
    threadId: THREAD,
    messageTs: "1711111111.000002",
    signed: true,
  } as const;
}

async function setup(options: {
  pipelineStore?: PipelineStore;
  sessionStore?: SessionStore;
} = {}) {
  const pipelineStore = options.pipelineStore ?? new InMemoryPipelineStore();
  const sessionStore = options.sessionStore ?? new InMemorySessionStore();
  const session = createSession(THREAD, CHANNEL);
  session.activeAgentName = "default";
  await sessionStore.set(THREAD, session);
  const runtime: PipelineToolRuntime = {
    store: pipelineStore,
    sessionStore,
    runtimeMode: "active",
    productPipelineEnabled: true,
    bugPipelineEnabled: true,
    githubTrackingEnabled: true,
  };
  return { pipelineStore, sessionStore, runtime };
}

const productArgs: PipelineStartRunArgs = {
  kind: "product",
  start_kind: "build",
  objective: "Implement a scoped event API flag, open a PR, and send it through review",
  reason: "The work now spans implementation, PR tracking, and independent review",
  idempotency_key: "event-flag-product-v1",
};

describe("pipeline_start_run", () => {
  it("does nothing until an authorized orchestrator deliberately calls it", async () => {
    const { pipelineStore } = await setup();
    expect(await pipelineStore.getRunByThread(THREAD)).toBeUndefined();
  });

  it("creates, audits, binds, and idempotently reuses a product run", async () => {
    const { pipelineStore, sessionStore, runtime } = await setup();

    const first = payload(await pipelineStartRun(runtime, context(), productArgs));
    const second = payload(await pipelineStartRun(runtime, context(), productArgs));

    expect(first.ok).toBe(true);
    expect(first.created).toBe(true);
    expect(second.ok).toBe(true);
    expect(second.created).toBe(false);

    const run = await pipelineStore.getRunByThread(THREAD);
    expect(run?.kind).toBe("product");
    const assignments = await pipelineStore.listAssignments(run!.id);
    const outbox = await pipelineStore.listOutbox(run!.id);
    const events = await pipelineStore.listEvents(run!.id);
    expect(assignments).toHaveLength(1);
    expect(outbox.filter((row) => row.eventType === "assignment.dispatch")).toHaveLength(1);
    expect(events.filter((event) => event.eventType === "pipeline.promoted")).toHaveLength(1);
    expect(await sessionStore.get(THREAD)).toMatchObject({
      activePipelineRunId: run!.id,
      activePipelineKind: "product",
    });
  });

  it("pumps the initial assignment with authoritative product context", async () => {
    const { pipelineStore, sessionStore, runtime } = await setup();
    const prompts: string[] = [];
    runtime.onRunStarted = async () => {
      await pumpOutbox({
        store: pipelineStore,
        sessionReader: sessionStore,
        dispatcher: {
          handleAgentMessage: async (event) => {
            prompts.push(event.text);
          },
        },
        workspaceRoot: "/workspace",
      });
    };

    expect(payload(await pipelineStartRun(runtime, context(), productArgs)).ok).toBe(true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("<product-context>");
    expect(prompts[0]).toContain("<pipeline-assignment>");
  });

  it("fails closed for unsigned, non-orchestrator, mismatched, and disabled calls", async () => {
    const { runtime } = await setup();
    expect(
      payload(await pipelineStartRun(runtime, { ...context(), signed: false }, productArgs)).ok,
    ).toBe(false);
    expect(
      payload(await pipelineStartRun(runtime, context("review"), productArgs)).ok,
    ).toBe(false);
    expect(
      payload(
        await pipelineStartRun(runtime, context(), {
          ...productArgs,
          kind: "bug",
          start_kind: "build",
        }),
      ).ok,
    ).toBe(false);
    expect(
      payload(
        await pipelineStartRun(
          { ...runtime, productPipelineEnabled: false },
          context(),
          productArgs,
        ),
      ).ok,
    ).toBe(false);
  });

  it("does not let a CHANNEL_DEFAULTS specialist prompt inherit default authority", async () => {
    const { sessionStore, runtime } = await setup();
    await sessionStore.mutateThread(THREAD, (session) => {
      session.agentType = "build";
    });

    const result = payload(await pipelineStartRun(runtime, context(), productArgs));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("does not own the current session turn");
  });

  it("allows a CHANNEL_DEFAULTS lead to upgrade a thread", async () => {
    const { sessionStore, runtime } = await setup();
    await sessionStore.mutateThread(THREAD, (session) => {
      session.agentType = "lead";
      session.activeAgentName = "lead";
    });

    const result = payload(
      await pipelineStartRun(runtime, context("lead"), {
        kind: "bug",
        start_kind: "debug",
        objective: "Reproduce, fix, validate, and review a systemic event-registration failure",
        reason: "The issue needs a durable reproduce-to-review loop",
        idempotency_key: "event-registration-debug-v1",
        bug_mode: "full-investigation",
      }),
    );
    expect(result.ok).toBe(true);
    expect((result.run as { ownerAgent: string }).ownerAgent).toBe("lead");
    expect((result.initialAssignment as { targetAgent: string }).targetAgent).toBe("lead");
  });

  it("resolves concurrent product-vs-bug promotion to one typed winner", async () => {
    const { pipelineStore, sessionStore, runtime } = await setup();
    const bugArgs: PipelineStartRunArgs = {
      kind: "bug",
      start_kind: "debug",
      objective: "Investigate a systemic event-registration failure",
      reason: "Durable reproduction, fix, validation, and review are required",
      idempotency_key: "event-registration-race-bug",
    };

    const results = await Promise.all([
      pipelineStartRun(runtime, context(), productArgs),
      pipelineStartRun(runtime, context(), bugArgs),
    ]);
    const bodies = results.map(payload);
    expect(bodies.filter((body) => body.ok === true)).toHaveLength(1);
    expect(bodies.filter((body) => body.ok === false)).toHaveLength(1);

    const run = await pipelineStore.getRunByThread(THREAD);
    expect(run).toBeDefined();
    expect(await pipelineStore.listAssignments(run!.id)).toHaveLength(1);
    expect(await pipelineStore.listOutbox(run!.id)).toHaveLength(1);
    expect(await sessionStore.get(THREAD)).toMatchObject({
      activePipelineRunId: run!.id,
      activePipelineKind: run!.kind,
    });
  });

  it("repairs a session-binding failure on retry without duplicating the run", async () => {
    const baseSessions = new InMemorySessionStore();
    let failBind = true;
    const sessions = new Proxy(baseSessions, {
      get(target, property, receiver) {
        if (property === "mutateThread") {
          return async (...args: Parameters<SessionStore["mutateThread"]>) => {
            if (failBind) {
              failBind = false;
              throw new Error("injected session bind failure");
            }
            return target.mutateThread(...args);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as SessionStore;
    const { pipelineStore, runtime } = await setup({ sessionStore: sessions });

    expect(payload(await pipelineStartRun(runtime, context(), productArgs)).ok).toBe(false);
    expect(payload(await pipelineStartRun(runtime, context(), productArgs)).ok).toBe(true);

    const run = await pipelineStore.getRunByThread(THREAD);
    expect(await pipelineStore.listAssignments(run!.id)).toHaveLength(1);
    expect(await pipelineStore.listOutbox(run!.id)).toHaveLength(1);
    expect(await sessions.get(THREAD)).toMatchObject({
      activePipelineRunId: run!.id,
      activePipelineKind: "product",
    });
  });

  it("repairs a failed initial outbox enqueue on retry", async () => {
    const basePipeline = new InMemoryPipelineStore();
    let failEnqueue = true;
    const pipelineStore = new Proxy(basePipeline, {
      get(target, property, receiver) {
        if (property === "enqueueOutbox") {
          return async (...args: Parameters<PipelineStore["enqueueOutbox"]>) => {
            if (failEnqueue) {
              failEnqueue = false;
              throw new Error("injected outbox failure");
            }
            return target.enqueueOutbox(...args);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as PipelineStore;
    const { runtime } = await setup({ pipelineStore });

    expect(payload(await pipelineStartRun(runtime, context(), productArgs)).ok).toBe(false);
    expect(payload(await pipelineStartRun(runtime, context(), productArgs)).ok).toBe(true);

    const run = await pipelineStore.getRunByThread(THREAD);
    expect(await pipelineStore.listAssignments(run!.id)).toHaveLength(1);
    expect(await pipelineStore.listOutbox(run!.id)).toHaveLength(1);
    expect(
      (await pipelineStore.listEvents(run!.id)).filter(
        (event) => event.eventType === "pipeline.promoted",
      ),
    ).toHaveLength(1);
  });
});
