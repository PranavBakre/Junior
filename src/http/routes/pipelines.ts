import type { PipelineStore } from "../../pipelines/store/interface.ts";
import type {
  Assignment,
  PipelineOutboxRecord,
  PipelineRun,
  StoredOutcome,
} from "../../pipelines/types.ts";

const RUN_STATUSES = new Set(["active", "waiting", "needs-human", "terminal"]);
const RUN_KINDS = new Set(["default", "product", "bug"]);

export async function handlePipelines(
  store: PipelineStore,
  params: URLSearchParams,
  runId?: string,
): Promise<Response> {
  if (runId) {
    const run = await store.getRun(runId);
    if (!run) return Response.json({ error: "pipeline not found" }, { status: 404 });
    return Response.json({ pipeline: await projectPipeline(store, run) });
  }

  const rawStatus = params.get("status");
  const status = rawStatus && RUN_STATUSES.has(rawStatus)
    ? rawStatus as PipelineRun["status"]
    : undefined;
  const rawKind = params.get("kind");
  const kind = rawKind && RUN_KINDS.has(rawKind)
    ? rawKind as PipelineRun["kind"]
    : undefined;

  const [runs, openCount] = await Promise.all([
    store.listRuns({ status, kind, limit: 100 }),
    store.countOpenRuns(),
  ]);
  const pipelines = runs.map(projectRun);

  return Response.json({ pipelines, openCount });
}

async function projectPipeline(store: PipelineStore, run: PipelineRun) {
  const [assignments, events, outbox, outcomes] = await Promise.all([
    store.listAssignments(run.id),
    store.listEvents(run.id),
    store.listOutbox(run.id),
    store.listOutcomesForRun(run.id),
  ]);
  const dispatchByAssignment = latestDispatches(outbox);
  const outcomesByAssignment = new Map<string, StoredOutcome[]>();
  for (const outcome of outcomes) {
    const grouped = outcomesByAssignment.get(outcome.assignmentId) ?? [];
    grouped.push(outcome);
    outcomesByAssignment.set(outcome.assignmentId, grouped);
  }

  return {
    ...projectRun(run),
    assignments: assignments
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((assignment) =>
        projectAssignment(
          assignment,
          dispatchByAssignment.get(assignment.id),
          outcomesByAssignment.get(assignment.id) ?? [],
        )
      ),
    transitions: events
      .filter((event) =>
        event.fromPhase !== null &&
        event.toPhase !== null &&
        event.fromPhase !== event.toPhase
      )
      .map((event) => ({
        id: event.id,
        sequence: event.sequence,
        fromPhase: event.fromPhase,
        toPhase: event.toPhase,
        actorType: event.actorType,
        actorId: event.actorId,
        occurredAt: event.occurredAt,
      })),
  };
}

function projectRun(run: PipelineRun) {
  return {
    id: run.id,
    kind: run.kind,
    channelId: run.channelId,
    threadId: run.threadId,
    phase: run.phase,
    status: run.status,
    ownerAgent: run.ownerAgent,
    repoRefs: run.repoRefs,
    activeAttemptId: run.activeAttemptId,
    stateVersion: run.stateVersion,
    terminalOutcome: run.terminalOutcome,
    terminalReason: run.terminalReason,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function projectAssignment(
  assignment: Assignment,
  dispatch: PipelineOutboxRecord | undefined,
  outcomes: StoredOutcome[],
) {
  return {
    id: assignment.id,
    parentAssignmentId: assignment.parentAssignmentId,
    sourceAgent: assignment.sourceAgent,
    targetAgent: assignment.targetAgent,
    status: assignment.status,
    objective: assignment.objective,
    attempt: assignment.attempt,
    attemptId: assignment.attemptId,
    dependsOn: assignment.dependsOn,
    createdAt: assignment.createdAt,
    updatedAt: assignment.updatedAt,
    outcomes: outcomes.map((outcome) => ({
      id: outcome.id,
      action: outcome.action,
      status: outcome.status,
      reason: outcome.reason,
      blockers: outcome.blockers,
      checks: outcome.checks,
      createdAt: outcome.createdAt,
    })),
    dispatch: dispatch
      ? {
          status: dispatch.status,
          attempts: dispatch.attempts,
          availableAt: dispatch.availableAt,
          deliveredAt: dispatch.deliveredAt,
          lastError: dispatch.lastError,
        }
      : null,
  };
}

function latestDispatches(
  outbox: PipelineOutboxRecord[],
): Map<string, PipelineOutboxRecord> {
  const result = new Map<string, PipelineOutboxRecord>();
  for (const record of outbox) {
    if (
      !record.assignmentId ||
      !["assignment.dispatch", "assignment.continue", "assignment.resume"].includes(
        record.eventType,
      )
    ) {
      continue;
    }
    const current = result.get(record.assignmentId);
    if (!current || record.createdAt > current.createdAt) {
      result.set(record.assignmentId, record);
    }
  }
  return result;
}
