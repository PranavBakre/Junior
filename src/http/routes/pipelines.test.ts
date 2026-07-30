import { describe, expect, it } from "bun:test";
import { InMemoryPipelineStore } from "../../pipelines/store/memory.ts";
import type { AssignmentCreate, PipelineRun } from "../../pipelines/types.ts";
import { handlePipelines } from "./pipelines.ts";

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

    const allResponse = await handlePipelines(store, new URLSearchParams());
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
