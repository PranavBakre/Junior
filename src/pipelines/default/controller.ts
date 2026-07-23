import type { Clock } from "../../time/clock.ts";
import { systemClock } from "../../time/clock.ts";
import type { PipelineStore } from "../store/interface.ts";
import {
  PIPELINE_DEFINITION_VERSION,
  type Assignment,
  type DefaultRun,
} from "../types.ts";

export type CreateDefaultRunInput = {
  channelId: string;
  threadId: string;
  objective: string;
  messageTs: string;
  targetAgent: string;
  sourceAgent?: string | "human" | "system";
  /** Original human Slack user ID for prompt attribution. */
  sourceSlackUserId?: string | null;
  repoRefs?: string[];
  acceptanceCriteria?: string[];
  runId?: string;
};

export type CreateDefaultRunResult = {
  run: DefaultRun;
  assignment: Assignment;
  created: boolean;
};

/** Create the durable single-owner run that backs every ordinary task. */
export async function createDefaultRun(
  config: { store: PipelineStore; clock?: Clock },
  input: CreateDefaultRunInput,
): Promise<CreateDefaultRunResult> {
  const clock = config.clock ?? systemClock;
  const now = clock.now();
  const existing = await config.store.getRunByThread(input.threadId);
  if (existing && existing.status !== "terminal") {
    if (existing.kind !== "default") {
      throw new Error(`thread already has an active ${existing.kind} pipeline`);
    }
    const assignments = await config.store.listAssignments(existing.id);
    const open = assignments.find((assignment) =>
      assignment.status === "pending" ||
      assignment.status === "leased" ||
      assignment.status === "waiting"
    );
    if (!open) throw new Error(`active default run ${existing.id} has no open assignment`);
    return { run: existing, assignment: open, created: false };
  }

  const runId = input.runId ?? crypto.randomUUID();
  const assignmentId = crypto.randomUUID();
  const run: DefaultRun = {
    id: runId,
    kind: "default",
    definitionVersion: PIPELINE_DEFINITION_VERSION,
    channelId: input.channelId,
    threadId: input.threadId,
    phase: "working",
    status: "active",
    ownerAgent: input.targetAgent,
    repoRefs: unique(input.repoRefs ?? []),
    acceptanceCriteria: input.acceptanceCriteria ?? [],
    artifactRefs: [],
    blockerRefs: [],
    activeAttemptId: null,
    stateVersion: 0,
    deadlineAt: null,
    terminalOutcome: null,
    terminalReason: null,
    createdAt: now,
    updatedAt: now,
  };
  const assignmentKey = `default-start:${input.threadId}:${input.messageTs}:${input.targetAgent}`;
  const assignment = await config.store.createRunWithAssignment({
    run,
    assignment: {
      id: assignmentId,
      runId,
      parentAssignmentId: null,
      sourceAgent: input.sourceAgent ?? "human",
      sourceSlackUserId: input.sourceSlackUserId ?? null,
      targetAgent: input.targetAgent,
      objective: input.objective,
      contextRefs: [`source-message:${input.messageTs}`],
      artifactRefs: [],
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      mutationScope:
        input.targetAgent === "build" || input.targetAgent === "frontend"
          ? ["worktree-code"]
          : [],
      dependsOn: [],
      attempt: 1,
      attemptId: null,
      candidateRevisionDigest: null,
      deadlineAt: null,
      idempotencyKey: assignmentKey,
    },
    events: [{
      id: crypto.randomUUID(),
      runId,
      eventType: "default.started",
      actorType: input.sourceAgent === "system" ? "system" : "human",
      actorId: input.sourceAgent ?? "human",
      assignmentId,
      outcomeId: null,
      fromPhase: null,
      toPhase: "working",
      payloadVersion: 1,
      payload: {
        targetAgent: input.targetAgent,
        sourceMessageTs: input.messageTs,
      },
      idempotencyKey: `default.started:${assignmentKey}`,
      occurredAt: now,
      observedAt: now,
    }],
    outbox: [{
      id: crypto.randomUUID(),
      runId,
      assignmentId,
      eventType: "assignment.dispatch",
      payload: {
        assignmentId,
        targetAgent: input.targetAgent,
        sourceMessageTs: input.messageTs,
      },
      idempotencyKey: `default-dispatch:${assignmentKey}`,
    }],
  });
  return { run, assignment, created: true };
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
