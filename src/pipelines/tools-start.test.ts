import { describe, expect, it } from "bun:test";
import type { RepoConfig } from "../config.ts";
import { createSession } from "../session/types.ts";
import { InMemorySessionStore } from "../session/store/memory.ts";
import type { SessionStore } from "../session/store/interface.ts";
import type { PipelineStore } from "./store/interface.ts";
import { InMemoryPipelineStore } from "./store/memory.ts";
import { pumpOutbox } from "./pump.ts";
import { createDefaultRun } from "./default/controller.ts";
import {
  pipelineStartRun,
  type PipelineStartRunArgs,
  type PipelineToolRuntime,
  type ToolTextResult,
} from "./tools.ts";

const THREAD = "1711111111.000001";
const CHANNEL = "C-PIPELINE";
const REPOS: RepoConfig[] = [
  {
    name: "example-backend",
    path: "/repos/example-backend",
    defaultBase: "origin/main",
    githubRepo: "Example/example-backend",
  },
];

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
    repos: REPOS,
  };
  return { pipelineStore, sessionStore, runtime };
}

const productArgs: PipelineStartRunArgs = {
  kind: "product",
  start_kind: "build",
  objective: "Implement a scoped event API flag, open a PR, and send it through review",
  reason: "The work now spans implementation, PR tracking, and independent review",
  idempotency_key: "event-flag-product-v1",
  repo_refs: ["example-backend"],
};

describe("pipeline_start_run", () => {
  it("promotes the caller's active default run in place", async () => {
    const { pipelineStore, sessionStore, runtime } = await setup();
    const started = await createDefaultRun(
      { store: pipelineStore },
      {
        channelId: CHANNEL,
        threadId: THREAD,
        objective: productArgs.objective,
        messageTs: context().messageTs,
        targetAgent: "default",
      },
    );
    for (const outbox of await pipelineStore.listOutbox(started.run.id)) {
      await pipelineStore.markOutboxDelivered(outbox.id);
    }
    await sessionStore.mutateThread(THREAD, (session) => {
      session.activeRunId = started.run.id;
      session.activePipelineInvocation = {
        runId: started.run.id,
        assignmentId: started.assignment.id,
        dispatchKey: "default-dispatch",
        outcomeCountAtDispatch: 0,
        retryCount: 0,
      };
    });

    const result = payload(await pipelineStartRun(runtime, {
      ...context(),
      runId: started.run.id,
      assignmentId: started.assignment.id,
      dispatchKey: "default-dispatch",
    }, productArgs));
    expect(result.ok).toBe(true);
    expect(result.created).toBe(false);
    expect(result.promoted).toBe(true);
    expect((result.run as { id: string; kind: string })).toMatchObject({
      id: started.run.id,
      kind: "product",
    });
    expect(await pipelineStore.getAssignment(started.assignment.id)).toMatchObject({
      status: "completed",
    });
    expect(await pipelineStore.listOutcomes(started.assignment.id)).toHaveLength(1);
    expect(await sessionStore.get(THREAD)).toMatchObject({
      activeRunId: started.run.id,
      activePipelineRunId: started.run.id,
      activePipelineKind: "product",
    });
  });

  it("does nothing until an authorized orchestrator deliberately calls it", async () => {
    const { pipelineStore } = await setup();
    expect(await pipelineStore.getRunByThread(THREAD)).toBeUndefined();
  });

  it("rejects worktree-backed starts without repo context before creating a run", async () => {
    const { pipelineStore, runtime } = await setup();

    for (const args of [
      {
        ...productArgs,
        repo_refs: undefined,
      },
      {
        kind: "bug" as const,
        start_kind: "reproducer" as const,
        objective: "Reproduce the reported verification failure",
        reason: "The report needs a browser reproduction",
        idempotency_key: "missing-reproducer-repo",
      },
    ]) {
      const result = payload(await pipelineStartRun(runtime, context(), args));
      expect(result).toMatchObject({
        ok: false,
        code: "pipeline_repo_context_required",
        retryable: true,
      });
      expect(result.reason).toContain("repo routing map");
      expect(await pipelineStore.getRunByThread(THREAD)).toBeUndefined();
    }
  });

  it("rejects unknown repo refs before creating a run", async () => {
    const { pipelineStore, runtime } = await setup();
    const result = payload(
      await pipelineStartRun(runtime, context(), {
        ...productArgs,
        repo_refs: ["not-configured"],
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      code: "pipeline_repo_context_invalid",
      repoRefs: ["not-configured"],
      retryable: true,
    });
    expect(await pipelineStore.getRunByThread(THREAD)).toBeUndefined();
  });

  it("refuses a reproducer when the debug intake established no scope", async () => {
    const { runtime } = await setup();
    // The skill steers raw reports through `debug` first so the scope is settled
    // before a worker is dispatched. A live run carrying no refs is not a replay
    // worth exempting — that is the flow where the scope was meant to be set.
    const debug = payload(await pipelineStartRun(runtime, context(), {
      kind: "bug",
      start_kind: "debug",
      objective: "triage the reported mismatch",
      reason: "raw bug reports start with debug",
      idempotency_key: "debug-intake-v1",
    }));
    expect(debug.ok).toBe(true);
    expect((debug.run as { repoRefs: string[] }).repoRefs).toEqual([]);

    const reproducer = payload(await pipelineStartRun(runtime, context(), {
      kind: "bug",
      start_kind: "reproducer",
      objective: "reproduce the reported mismatch",
      reason: "triage is done, now reproduce",
      idempotency_key: "debug-then-reproducer-v1",
    }));

    expect(reproducer).toMatchObject({
      ok: false,
      code: "pipeline_repo_context_required",
      retryable: true,
    });
  });

  it("keeps a two-repo source's scope for a debug start", async () => {
    const { pipelineStore, sessionStore, runtime } = await setup();
    const twoRepos: RepoConfig[] = [
      {
        name: "example-backend",
        path: "/repos/example-backend",
        defaultBase: "origin/main",
        githubRepo: "Example/example-backend",
      },
      {
        name: "example-client",
        path: "/repos/example-client",
        defaultBase: "origin/main",
        githubRepo: "Example/example-client",
      },
    ];
    const started = await createDefaultRun({ store: pipelineStore }, {
      channelId: CHANNEL,
      threadId: THREAD,
      objective: "triage the reported issue",
      messageTs: context().messageTs,
      targetAgent: "default",
      repoRefs: ["example-backend", "example-client"],
    });
    for (const outbox of await pipelineStore.listOutbox(started.run.id)) {
      await pipelineStore.markOutboxDelivered(outbox.id);
    }
    await sessionStore.mutateThread(THREAD, (session) => {
      session.activeRunId = started.run.id;
      session.activePipelineInvocation = {
        runId: started.run.id,
        assignmentId: started.assignment.id,
        dispatchKey: "default-dispatch",
        outcomeCountAtDispatch: 0,
        retryCount: 0,
      };
    });

    // `debug` needs no repository to pass the guard, so nothing resolves a scope
    // here — the promotion must keep the source run's own, or the pending
    // worktree-code assignment hits the dispatch-time unresolved-ref throw.
    const result = payload(await pipelineStartRun(
      { ...runtime, repos: twoRepos },
      {
        ...context(),
        runId: started.run.id,
        assignmentId: started.assignment.id,
        dispatchKey: "default-dispatch",
      },
      {
        kind: "bug",
        start_kind: "debug",
        objective: "triage the reported mismatch",
        reason: "raw bug reports start with debug",
        idempotency_key: "two-repo-debug-v1",
      },
    ));

    expect(result.ok).toBe(true);
    expect((result.run as { repoRefs: string[] }).repoRefs).toEqual([
      "example-backend",
      "example-client",
    ]);
  });

  it("does not narrow a two-repo run to the thread binding", async () => {
    const { pipelineStore, sessionStore, runtime } = await setup();
    const twoRepos: RepoConfig[] = [
      {
        name: "example-backend",
        path: "/repos/example-backend",
        defaultBase: "origin/main",
        githubRepo: "Example/example-backend",
      },
      {
        name: "example-client",
        path: "/repos/example-client",
        defaultBase: "origin/main",
        githubRepo: "Example/example-client",
      },
    ];
    const started = await createDefaultRun({ store: pipelineStore }, {
      channelId: CHANNEL,
      threadId: THREAD,
      objective: "triage the reported issue",
      messageTs: context().messageTs,
      targetAgent: "default",
      repoRefs: ["example-backend", "example-client"],
    });
    for (const outbox of await pipelineStore.listOutbox(started.run.id)) {
      await pipelineStore.markOutboxDelivered(outbox.id);
    }
    await sessionStore.mutateThread(THREAD, (session) => {
      // A binding that names one of the two. It must not replace the run's
      // scope: the dropped repo is never provisioned and never reaches
      // downstream agents, and there is no repair path back.
      session.targetRepo = "example-client";
      session.activeRunId = started.run.id;
      session.activePipelineInvocation = {
        runId: started.run.id,
        assignmentId: started.assignment.id,
        dispatchKey: "default-dispatch",
        outcomeCountAtDispatch: 0,
        retryCount: 0,
      };
    });

    const result = payload(await pipelineStartRun(
      { ...runtime, repos: twoRepos },
      {
        ...context(),
        runId: started.run.id,
        assignmentId: started.assignment.id,
        dispatchKey: "default-dispatch",
      },
      {
        kind: "bug",
        start_kind: "debug",
        objective: "triage the reported mismatch",
        reason: "raw bug reports start with debug",
        idempotency_key: "two-repo-binding-v1",
      },
    ));

    expect(result.ok).toBe(true);
    expect((result.run as { repoRefs: string[] }).repoRefs).toEqual([
      "example-backend",
      "example-client",
    ]);
  });

  it("replays a live same-kind run instead of re-asking for its scope", async () => {
    const { runtime } = await setup();
    const first = payload(await pipelineStartRun(runtime, context(), productArgs));
    expect(first.ok).toBe(true);
    expect(first.created).toBe(true);

    // The run's refs are rendered in no prompt block, so a follow-up that
    // declares nothing replays it rather than demanding scope the caller has no
    // way to observe. Refusing here would reject a call origin/main accepted.
    const replay = payload(await pipelineStartRun(runtime, context(), {
      ...productArgs,
      repo_refs: [],
      idempotency_key: "same-kind-replay-v1",
    }));

    expect(replay.ok).toBe(true);
    expect(replay.created).toBe(false);
  });

  it("does not let the promotion source widen a declared scope", async () => {
    const { pipelineStore, sessionStore, runtime } = await setup();
    const twoRepos: RepoConfig[] = [
      {
        name: "example-backend",
        path: "/repos/example-backend",
        defaultBase: "origin/main",
        githubRepo: "Example/example-backend",
      },
      {
        name: "example-client",
        path: "/repos/example-client",
        defaultBase: "origin/main",
        githubRepo: "Example/example-client",
      },
    ];
    // Live default run scoped to the client repo, and a directive that names
    // only the backend one. The durable run must end up backend-only: the extra
    // ref would be provisioned, and for a reproducer (no workstream affinity)
    // would win the primary-cwd tiebreak and reproduce against the wrong repo.
    const started = await createDefaultRun({ store: pipelineStore }, {
      channelId: CHANNEL,
      threadId: THREAD,
      objective: "triage the reported issue",
      messageTs: context().messageTs,
      targetAgent: "default",
      repoRefs: ["example-client"],
    });
    for (const outbox of await pipelineStore.listOutbox(started.run.id)) {
      await pipelineStore.markOutboxDelivered(outbox.id);
    }
    await sessionStore.mutateThread(THREAD, (session) => {
      session.activeRunId = started.run.id;
      session.activePipelineInvocation = {
        runId: started.run.id,
        assignmentId: started.assignment.id,
        dispatchKey: "default-dispatch",
        outcomeCountAtDispatch: 0,
        retryCount: 0,
      };
    });

    const result = payload(await pipelineStartRun(
      { ...runtime, repos: twoRepos },
      {
        ...context(),
        runId: started.run.id,
        assignmentId: started.assignment.id,
        dispatchKey: "default-dispatch",
      },
      {
        kind: "bug",
        start_kind: "reproducer",
        objective: "reproduce the reported mismatch",
        reason: "the report needs a live reproduction before a fix",
        idempotency_key: "narrow-declared-v1",
        repo_refs: ["example-backend"],
      },
    ));

    expect(result.ok).toBe(true);
    expect((result.run as { repoRefs: string[] }).repoRefs).toEqual([
      "example-backend",
    ]);
  });

  it("rejects a start whose only scope is a stale thread binding", async () => {
    const { sessionStore, runtime } = await setup();
    // A `!repo` binding that no longer resolves. Nothing is declared, so this is
    // the ref the start would actually run on — validating only caller-supplied
    // refs would admit a scope that can never dispatch.
    await sessionStore.mutateThread(THREAD, (session) => {
      session.targetRepo = "not-configured";
    });

    const result = payload(await pipelineStartRun(runtime, context(), {
      kind: "bug",
      start_kind: "reproducer",
      objective: "reproduce the reported mismatch",
      reason: "the report needs a live reproduction before a fix",
      idempotency_key: "stale-binding-v1",
    }));

    expect(result).toMatchObject({
      ok: false,
      code: "pipeline_repo_context_invalid",
      retryable: true,
    });
  });

  it("prefers the run's own scope over a thread binding", async () => {
    const { pipelineStore, sessionStore, runtime } = await setup();
    const twoRepos: RepoConfig[] = [
      {
        name: "example-backend",
        path: "/repos/example-backend",
        defaultBase: "origin/main",
        githubRepo: "Example/example-backend",
      },
      {
        name: "example-client",
        path: "/repos/example-client",
        defaultBase: "origin/main",
        githubRepo: "Example/example-client",
      },
    ];
    const started = await createDefaultRun({ store: pipelineStore }, {
      channelId: CHANNEL,
      threadId: THREAD,
      objective: "triage the reported issue",
      messageTs: context().messageTs,
      targetAgent: "default",
      repoRefs: ["example-backend"],
    });
    for (const outbox of await pipelineStore.listOutbox(started.run.id)) {
      await pipelineStore.markOutboxDelivered(outbox.id);
    }
    await sessionStore.mutateThread(THREAD, (session) => {
      // The binding disagrees with the run. `!repo` is re-derived per message,
      // so it must not replace the scope the run already holds.
      session.targetRepo = "example-client";
      session.activeRunId = started.run.id;
      session.activePipelineInvocation = {
        runId: started.run.id,
        assignmentId: started.assignment.id,
        dispatchKey: "default-dispatch",
        outcomeCountAtDispatch: 0,
        retryCount: 0,
      };
    });

    const result = payload(await pipelineStartRun(
      { ...runtime, repos: twoRepos },
      {
        ...context(),
        runId: started.run.id,
        assignmentId: started.assignment.id,
        dispatchKey: "default-dispatch",
      },
      {
        kind: "bug",
        start_kind: "reproducer",
        objective: "reproduce the reported mismatch",
        reason: "the report needs a live reproduction before a fix",
        idempotency_key: "binding-not-authoritative-v1",
      },
    ));

    expect(result.ok).toBe(true);
    expect((result.run as { repoRefs: string[] }).repoRefs).toEqual([
      "example-backend",
    ]);
  });

  it("inherits an unambiguous single-repo source when nothing is declared", async () => {
    const { pipelineStore, sessionStore, runtime } = await setup();
    const started = await createDefaultRun({ store: pipelineStore }, {
      channelId: CHANNEL,
      threadId: THREAD,
      objective: "triage the reported issue",
      messageTs: context().messageTs,
      targetAgent: "default",
      repoRefs: ["example-backend"],
    });
    for (const outbox of await pipelineStore.listOutbox(started.run.id)) {
      await pipelineStore.markOutboxDelivered(outbox.id);
    }
    await sessionStore.mutateThread(THREAD, (session) => {
      session.activeRunId = started.run.id;
      session.activePipelineInvocation = {
        runId: started.run.id,
        assignmentId: started.assignment.id,
        dispatchKey: "default-dispatch",
        outcomeCountAtDispatch: 0,
        retryCount: 0,
      };
    });

    const result = payload(await pipelineStartRun(
      runtime,
      {
        ...context(),
        runId: started.run.id,
        assignmentId: started.assignment.id,
        dispatchKey: "default-dispatch",
      },
      { ...productArgs, repo_refs: [], idempotency_key: "single-repo-inherit-v1" },
    ));

    expect(result.ok).toBe(true);
    expect((result.run as { repoRefs: string[] }).repoRefs).toEqual([
      "example-backend",
    ]);
  });

  it("refuses a promotion whose source scope is ambiguous", async () => {
    const { pipelineStore, sessionStore, runtime } = await setup();
    const twoRepos: RepoConfig[] = [
      {
        name: "example-backend",
        path: "/repos/example-backend",
        defaultBase: "origin/main",
        githubRepo: "Example/example-backend",
      },
      {
        name: "example-client",
        path: "/repos/example-client",
        defaultBase: "origin/main",
        githubRepo: "Example/example-client",
      },
    ];
    const started = await createDefaultRun({ store: pipelineStore }, {
      channelId: CHANNEL,
      threadId: THREAD,
      objective: "triage the reported issue",
      messageTs: context().messageTs,
      targetAgent: "default",
      repoRefs: ["example-backend", "example-client"],
    });
    for (const outbox of await pipelineStore.listOutbox(started.run.id)) {
      await pipelineStore.markOutboxDelivered(outbox.id);
    }
    await sessionStore.mutateThread(THREAD, (session) => {
      session.activeRunId = started.run.id;
      session.activePipelineInvocation = {
        runId: started.run.id,
        assignmentId: started.assignment.id,
        dispatchKey: "default-dispatch",
        outcomeCountAtDispatch: 0,
        retryCount: 0,
      };
    });

    // The caller declares nothing, so the promotion source is the only scope on
    // offer — and a two-repo one is ambiguous about which repo this start
    // concerns. Inheriting it would also feed workstream inference and fan a
    // single-repo build into a full-stack one it never asked for. Ask instead.
    const result = payload(await pipelineStartRun(
      { ...runtime, repos: twoRepos },
      {
        ...context(),
        runId: started.run.id,
        assignmentId: started.assignment.id,
        dispatchKey: "default-dispatch",
      },
      { ...productArgs, repo_refs: [], idempotency_key: "ambiguous-promotion-v1" },
    ));

    expect(result).toMatchObject({
      ok: false,
      code: "pipeline_repo_context_required",
      retryable: true,
    });
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
