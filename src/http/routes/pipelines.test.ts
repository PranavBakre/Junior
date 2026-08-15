import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryPipelineStore } from "../../pipelines/store/memory.ts";
import type {
  AssignmentCreate,
  PipelineAttempt,
  PipelineGate,
  PipelineRun,
} from "../../pipelines/types.ts";
import { handlePipelineArtifact, handlePipelines } from "./pipelines.ts";

describe("handlePipelines", () => {
  it("projects recent runs as assignment dispatch flows", async () => {
    const store = new InMemoryPipelineStore();
    const run = makeRun();
    const root = makeAssignment(run.id, "root", null, "system", "build");
    const child = makeAssignment(run.id, "child", root.id, "build", "review");

    await store.createRunWithAssignment({
      run,
      assignment: root,
      outbox: [{
        id: "dispatch-root",
        runId: run.id,
        assignmentId: root.id,
        eventType: "assignment.dispatch",
        payload: {},
        idempotencyKey: "dispatch-root",
        status: "delivered",
      }],
    });
    const outcomeReceipt = await store.recordOutcomeTransaction({
      outcome: {
        assignmentId: root.id,
        expectedRunVersion: 1,
        action: "continue_self",
        status: "progress",
        reason: "The implementation handoff is ready.",
        evidenceRefs: ["e1"],
        artifactRefs: [],
        blockers: [],
        checks: [],
        progressFingerprint: "architecture-ready",
      },
      actorType: "agent",
      actorId: "build",
      idempotencyKey: "architecture-ready",
      toPhase: "aggregate-verification",
    });
    expect(outcomeReceipt.status).toBe("accepted");
    await store.createAssignmentWithOutbox({
      assignment: child,
      outbox: {
        id: "dispatch-child",
        runId: run.id,
        assignmentId: child.id,
        eventType: "assignment.dispatch",
        payload: {},
        idempotencyKey: "dispatch-child",
        status: "pending",
      },
    });

    const indexResponse = await handlePipelines(store, new URLSearchParams());
    const indexBody = await indexResponse.json() as {
      pipelines: Array<{ id: string; assignments?: unknown[] }>;
      openCount: number;
    };
    expect(indexBody.pipelines).toEqual([
      expect.objectContaining({ id: run.id }),
    ]);
    expect(indexBody.pipelines[0]!.assignments).toBeUndefined();
    expect(indexBody.openCount).toBe(1);

    const response = await handlePipelines(
      store,
      new URLSearchParams(),
      run.id,
    );
    expect(response.status).toBe(200);
    const body = await response.json() as {
      pipeline: {
        id: string;
        assignments: Array<{
          id: string;
          parentAssignmentId: string | null;
          dispatch: { status: string } | null;
          outcomes: Array<{ reason: string }>;
        }>;
        transitions: Array<{
          id: string;
          sequence: number;
          fromPhase: string;
          toPhase: string;
          actorType: string;
          actorId: string;
          occurredAt: number;
        }>;
      };
    };

    expect(body.pipeline.id).toBe(run.id);
    expect(body.pipeline.assignments).toHaveLength(2);
    expect(body.pipeline.assignments[0]).toMatchObject({
      id: "root",
      dispatch: { status: "pending" },
      outcomes: [
        expect.objectContaining({
          reason: "The implementation handoff is ready.",
        }),
      ],
    });
    expect(body.pipeline.assignments[1]).toMatchObject({
      id: "child",
      parentAssignmentId: "root",
      dispatch: { status: "pending" },
    });
    expect(body.pipeline.transitions).toEqual([
      expect.objectContaining({
        sequence: 1,
        fromPhase: "building",
        toPhase: "aggregate-verification",
        actorType: "agent",
        actorId: "build",
      }),
    ]);
  });

  it("returns all runs and filters product and bug pipelines", async () => {
    const store = new InMemoryPipelineStore();
    for (let index = 0; index < 55; index += 1) {
      const run = makeRun(
        `run-${index}`,
        index,
        index % 2 === 0 ? "product" : "bug",
      );
      await store.createRunWithAssignment({
        run,
        assignment: makeAssignment(run.id, `asg-${index}`, null, "system", "default"),
      });
    }

    const allResponse = await handlePipelines(
      store,
      new URLSearchParams("limit=200"),
    );
    const allBody = await allResponse.json() as {
      pipelines: Array<{ kind: string }>;
    };
    expect(allBody.pipelines).toHaveLength(55);

    const bugResponse = await handlePipelines(
      store,
      new URLSearchParams("kind=bug"),
    );
    const bugBody = await bugResponse.json() as {
      pipelines: Array<{ kind: string }>;
    };
    expect(bugBody.pipelines).toHaveLength(27);
    expect(bugBody.pipelines.every((run) => run.kind === "bug")).toBe(true);
  });

  it("returns 404 for a missing pipeline detail", async () => {
    const response = await handlePipelines(
      new InMemoryPipelineStore(),
      new URLSearchParams(),
      "missing",
    );
    expect(response.status).toBe(404);
  });

  it("hides default-kind runs unless includeDefault=1 or kind=default", async () => {
    const store = new InMemoryPipelineStore();
    await store.createRunWithAssignment({
      run: makeRun("product-1", 3, "product"),
      assignment: makeAssignment("product-1", "asg-p", null, "system", "build"),
    });
    await store.createRunWithAssignment({
      run: makeRun("default-1", 2, "default"),
      assignment: makeAssignment("default-1", "asg-d", null, "system", "default"),
    });

    const hidden = await handlePipelines(store, new URLSearchParams());
    const hiddenBody = await hidden.json() as {
      pipelines: Array<{ id: string }>;
      openCount: number;
    };
    expect(hiddenBody.pipelines.map((run) => run.id)).toEqual(["product-1"]);
    expect(hiddenBody.openCount).toBe(1);

    const included = await handlePipelines(
      store,
      new URLSearchParams("includeDefault=1"),
    );
    const includedBody = await included.json() as {
      pipelines: Array<{ id: string }>;
      openCount: number;
    };
    expect(includedBody.pipelines.map((run) => run.id).sort()).toEqual([
      "default-1",
      "product-1",
    ]);
    expect(includedBody.openCount).toBe(2);

    const onlyDefault = await handlePipelines(
      store,
      new URLSearchParams("kind=default"),
    );
    const onlyDefaultBody = await onlyDefault.json() as {
      pipelines: Array<{ id: string; kind: string }>;
      openCount: number;
    };
    expect(onlyDefaultBody.pipelines).toEqual([
      expect.objectContaining({ id: "default-1", kind: "default" }),
    ]);
    expect(onlyDefaultBody.openCount).toBe(1);
  });

  it("projects lease, full outbox without payload, and attempt-scoped gates", async () => {
    const store = new InMemoryPipelineStore();
    const run = makeRun();
    run.activeAttemptId = "att-1";
    const root = makeAssignment(run.id, "root", null, "system", "build");
    root.status = "leased";
    root.leaseOwner = "build";
    root.leaseExpiresAt = 9_000;
    root.artifactRefs = ["spec.md"];

    await store.createRun(run);
    await store.createAssignment(root);
    await store.enqueueOutbox({
      id: "dispatch-root",
      runId: run.id,
      assignmentId: root.id,
      eventType: "assignment.dispatch",
      payload: { prompt: "secret outbox prompt" },
      idempotencyKey: "dispatch-root",
      status: "pending",
    });
    await store.createAttempt({
      id: "att-1",
      runId: run.id,
      ordinal: 1,
      revisionDigest: "digest-1",
      status: "open",
      invalidatedAt: null,
      invalidationReason: null,
      createdAt: 1,
      finishedAt: null,
    } satisfies PipelineAttempt);
    await store.replaceAttemptRevision("att-1", [{
      memberKey: "backend",
      repoRef: "junior",
      branch: "feature/x",
      headSha: "sha-a",
    }]);
    await store.upsertGate({
      id: "gate-review",
      runId: run.id,
      attemptId: "att-1",
      memberKey: "backend",
      githubResourceId: null,
      gateKind: "review",
      status: "pending",
      subjectSha: "sha-a",
      evidenceRef: null,
      provider: "claude",
      model: null,
      agentName: "review",
      updatedAt: 1,
    } satisfies PipelineGate);

    const response = await handlePipelines(store, new URLSearchParams(), run.id);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      pipeline: {
        assignments: Array<{
          id: string;
          leaseOwner: string | null;
          leaseExpiresAt: number | null;
        }>;
        outbox: Array<Record<string, unknown>>;
        gates: Array<{ id: string; attemptId: string }>;
        attempt: { id: string; digest: string | null } | null;
      };
    };

    expect(body.pipeline.assignments[0]).toMatchObject({
      id: "root",
      leaseOwner: "build",
      leaseExpiresAt: 9_000,
    });
    expect(body.pipeline.outbox).toHaveLength(1);
    expect(body.pipeline.outbox[0]).toMatchObject({
      id: "dispatch-root",
      eventType: "assignment.dispatch",
      status: "pending",
    });
    expect(body.pipeline.outbox[0]!.payload).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("secret outbox prompt");
    expect(body.pipeline.attempt).toMatchObject({ id: "att-1" });
    expect(body.pipeline.gates).toEqual([
      expect.objectContaining({ id: "gate-review", attemptId: "att-1" }),
    ]);
  });

  it("rejects artifact path traversal and missing artifacts", async () => {
    const store = new InMemoryPipelineStore();
    const run = makeRun("run-art");
    const assignment = makeAssignment(run.id, "root", null, "system", "build");
    assignment.artifactRefs = [
      "notes/spec.md",
      `data/pipelines/${run.id}/notes/spec.md`,
    ];
    await store.createRunWithAssignment({ run, assignment });
    const rootDir = mkdtempSync(join(tmpdir(), "junior-pipeline-art-"));
    try {
      for (const ref of [
        "../secret",
        "/etc/passwd",
        "data/pipelines/other-run/notes/spec.md",
      ]) {
        const rejected = await handlePipelineArtifact(
          store,
          run.id,
          new URLSearchParams({ ref }),
          { rootDir },
        );
        expect(rejected.status).toBe(400);
      }

      const missing = await handlePipelineArtifact(
        store,
        run.id,
        new URLSearchParams({ ref: "notes/spec.md" }),
        { rootDir },
      );
      expect(missing.status).toBe(404);

      const dest = join(rootDir, "data", "pipelines", run.id, "notes");
      mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, "spec.md"), "# spec\n");

      for (const ref of [
        "notes/spec.md",
        `data/pipelines/${run.id}/notes/spec.md`,
      ]) {
        const found = await handlePipelineArtifact(
          store,
          run.id,
          new URLSearchParams({ ref }),
          { rootDir },
        );
        expect(found.status).toBe(200);
        expect(await found.json()).toMatchObject({
          ref,
          content: "# spec\n",
          truncated: false,
        });
      }

      const detail = await handlePipelines(store, new URLSearchParams(), run.id);
      const detailBody = await detail.json() as {
        pipeline: { artifacts: Array<{ ref: string; readable: boolean }> };
      };
      expect(detailBody.pipeline.artifacts).toEqual(
        expect.arrayContaining([
          { ref: "notes/spec.md", readable: true },
          { ref: `data/pipelines/${run.id}/notes/spec.md`, readable: true },
        ]),
      );
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("keeps the polled list off Slack and resolves the permalink on detail", async () => {
    const store = new InMemoryPipelineStore();
    const run = makeRun();
    await store.createRunWithAssignment({
      run,
      assignment: makeAssignment(run.id, "root", null, "system", "build"),
      outbox: [],
    });

    let resolveCalls = 0;
    const resolveSlackPermalink = async () => {
      resolveCalls++;
      return "https://slack.example/thread";
    };
    const cached = new Map([["C123 thread-run-1", "https://slack.example/cached"]]);
    const lookupSlackPermalink = (channel: string, messageTs: string) =>
      cached.get(`${channel} ${messageTs}`) ?? null;

    const list = await handlePipelines(store, new URLSearchParams(), undefined, {
      resolveSlackPermalink,
      lookupSlackPermalink,
    });
    const listBody = await list.json() as {
      pipelines: Array<{ slackPermalink?: string | null }>;
    };
    expect(listBody.pipelines[0]!.slackPermalink).toBe("https://slack.example/cached");
    expect(resolveCalls).toBe(0);

    const detail = await handlePipelines(store, new URLSearchParams(), run.id, {
      resolveSlackPermalink,
      lookupSlackPermalink,
    });
    const detailBody = await detail.json() as {
      pipeline: { slackPermalink?: string | null };
    };
    expect(detailBody.pipeline.slackPermalink).toBe("https://slack.example/thread");
    expect(resolveCalls).toBe(1);
  });
});

function makeRun(
  id = "run-1",
  updatedAt = 2,
  kind: PipelineRun["kind"] = "product",
): PipelineRun {
  const base = {
    id,
    definitionVersion: 1,
    channelId: "C123",
    threadId: `thread-${id}`,
    status: "active" as const,
    ownerAgent: kind === "bug" ? "debug" : kind === "default" ? "default" : "build",
    repoRefs: ["junior"],
    acceptanceCriteria: [],
    artifactRefs: [],
    blockerRefs: [],
    activeAttemptId: null,
    stateVersion: 1,
    deadlineAt: null,
    terminalOutcome: null,
    terminalReason: null,
    createdAt: 1,
    updatedAt,
  };
  if (kind === "bug") return { ...base, kind: "bug", phase: "intake", ownerAgent: "debug" };
  if (kind === "default") {
    return { ...base, kind: "default", phase: "working", ownerAgent: "default" };
  }
  return { ...base, kind: "product", phase: "building" };
}

function makeAssignment(
  runId: string,
  id: string,
  parentAssignmentId: string | null,
  sourceAgent: string,
  targetAgent: string,
): AssignmentCreate {
  return {
    id,
    runId,
    parentAssignmentId,
    sourceAgent,
    sourceSlackUserId: null,
    targetAgent,
    objective: `${targetAgent} objective`,
    contextRefs: [],
    artifactRefs: [],
    acceptanceCriteria: [],
    mutationScope: [],
    dependsOn: [],
    attempt: 1,
    attemptId: null,
    candidateRevisionDigest: null,
    deadlineAt: null,
    idempotencyKey: `assignment-${id}`,
  };
}
