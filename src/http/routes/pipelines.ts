import { isAbsolute } from "node:path";
import type { PipelineRuntimeMode } from "../../config.ts";
import { resolvePipelineArtifactPath } from "../../pipelines/artifacts.ts";
import type { PipelineStore } from "../../pipelines/store/interface.ts";
import type {
  Assignment,
  PipelineEvent,
  PipelineOutboxRecord,
  PipelineRun,
  StoredOutcome,
} from "../../pipelines/types.ts";
import { parseLimit } from "../query.ts";
import type { SlackPermalinkResolver } from "./sessions.ts";

const RUN_STATUSES = new Set(["active", "waiting", "needs-human", "terminal"]);
const RUN_KINDS = new Set(["default", "product", "bug"]);
const OPEN_ASSIGNMENT = new Set(["pending", "leased", "waiting"]);
const ARTIFACT_CAP_BYTES = 256 * 1024;

export type PipelineRouteOptions = {
  runtimeMode?: PipelineRuntimeMode;
  resolveSlackPermalink?: SlackPermalinkResolver;
  rootDir?: string;
};

export async function handlePipelines(
  store: PipelineStore,
  params: URLSearchParams,
  runId?: string,
  options: PipelineRouteOptions = {},
): Promise<Response> {
  const runtimeMode = options.runtimeMode ?? "off";

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
  const limit = parseLimit(params.get("limit"), 50, 200);
  const includeDefault = params.get("includeDefault") === "1" || kind === "default";

  const [runs, openCount] = await Promise.all([
    listVisibleRuns(store, { status, kind, limit, includeDefault }),
    store.countOpenRuns(),
  ]);

  const pipelines = await Promise.all(
    runs.map((run) => projectRunSummary(store, run, options.resolveSlackPermalink)),
  );

  return Response.json({ pipelines, openCount, runtimeMode });
}

export async function handlePipelineArtifact(
  store: PipelineStore,
  runId: string,
  params: URLSearchParams,
  options: { rootDir?: string } = {},
): Promise<Response> {
  const run = await store.getRun(runId);
  if (!run) return Response.json({ error: "pipeline not found" }, { status: 404 });

  const ref = params.get("ref") ?? "";
  if (isRejectedArtifactRef(ref)) {
    return Response.json({ error: "invalid artifact ref" }, { status: 400 });
  }

  const resolved = resolvePipelineArtifactPath({
    runId,
    relativePath: ref,
    rootDir: options.rootDir,
  });
  if (!resolved.ok) {
    return Response.json({ error: resolved.reason }, { status: 400 });
  }

  const file = Bun.file(resolved.absPath);
  if (!(await file.exists())) {
    return Response.json({ error: "artifact not found" }, { status: 404 });
  }

  const truncated = file.size > ARTIFACT_CAP_BYTES;
  const content = truncated
    ? await file.slice(0, ARTIFACT_CAP_BYTES).text()
    : await file.text();
  return Response.json({ ref, content, truncated });
}

async function listVisibleRuns(
  store: PipelineStore,
  filter: {
    status?: PipelineRun["status"];
    kind?: PipelineRun["kind"];
    limit: number;
    includeDefault: boolean;
  },
): Promise<PipelineRun[]> {
  if (filter.kind) {
    return store.listRuns({
      status: filter.status,
      kind: filter.kind,
      limit: filter.limit,
    });
  }
  if (filter.includeDefault) {
    return store.listRuns({ status: filter.status, limit: filter.limit });
  }
  const [product, bug] = await Promise.all([
    store.listRuns({ status: filter.status, kind: "product", limit: filter.limit }),
    store.listRuns({ status: filter.status, kind: "bug", limit: filter.limit }),
  ]);
  return [...product, ...bug]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, filter.limit);
}

async function projectRunSummary(
  store: PipelineStore,
  run: PipelineRun,
  resolveSlackPermalink?: SlackPermalinkResolver,
) {
  const [assignments, outcomes] = await Promise.all([
    store.listAssignments(run.id),
    store.listOutcomesForRun(run.id),
  ]);
  const lastOutcome = [...outcomes].sort((a, b) => b.createdAt - a.createdAt)[0];
  let slackPermalink: string | null | undefined;
  if (resolveSlackPermalink) {
    try {
      slackPermalink = await resolveSlackPermalink(run.channelId, run.threadId);
    } catch {
      slackPermalink = null;
    }
  }
  return {
    ...projectRun(run),
    openAssignmentCount: assignments.filter((a) => OPEN_ASSIGNMENT.has(a.status)).length,
    assignmentCount: assignments.length,
    blockerCount:
      run.blockerRefs.length +
      outcomes.reduce((n, outcome) => n + outcome.blockers.length, 0),
    lastOutcomeSummary: lastOutcome?.reason ?? run.terminalReason,
    currentWorkers: assignments
      .filter((assignment) => assignment.status === "leased")
      .map((assignment) => ({
        agent: assignment.targetAgent,
        assignmentId: assignment.id,
        leaseExpiresAt: assignment.leaseExpiresAt,
      })),
    slackPermalink,
  };
}

async function projectPipeline(store: PipelineStore, run: PipelineRun) {
  const [assignments, events, outbox, outcomes] = await Promise.all([
    store.listAssignments(run.id),
    store.listEvents(run.id),
    store.listOutbox(run.id),
    store.listOutcomesForRun(run.id),
  ]);

  let attempt: {
    id: string;
    digest: string | null;
    members: Array<{
      memberKey: string;
      repoRef: string;
      branch: string;
      headSha: string;
    }>;
  } | null = null;
  let gates: Array<{
    id: string;
    attemptId: string;
    memberKey: string | null;
    gateKind: string;
    status: string;
    subjectSha: string | null;
    evidenceRef: string | null;
    provider: string | null;
    agentName: string | null;
    updatedAt: number;
  }> = [];

  if (run.activeAttemptId) {
    const [att, members, attGates] = await Promise.all([
      store.getAttempt(run.activeAttemptId),
      store.listRevisionMembers(run.activeAttemptId),
      store.listGates(run.activeAttemptId),
    ]);
    if (att) {
      attempt = {
        id: att.id,
        digest: att.revisionDigest,
        members: members.map((member) => ({
          memberKey: member.memberKey,
          repoRef: member.repoRef,
          branch: member.branch,
          headSha: member.headSha,
        })),
      };
    }
    gates = attGates.map((gate) => ({
      id: gate.id,
      attemptId: gate.attemptId,
      memberKey: gate.memberKey,
      gateKind: gate.gateKind,
      status: gate.status,
      subjectSha: gate.subjectSha,
      evidenceRef: gate.evidenceRef,
      provider: gate.provider,
      agentName: gate.agentName,
      updatedAt: gate.updatedAt,
    }));
  }

  const [githubAssocs, devServerJobs] = await Promise.all([
    store.listPipelineGitHubResources(run.id),
    store.listDevServerJobs({ runId: run.id }),
  ]);
  const githubResources = await Promise.all(
    githubAssocs.map(async (assoc) => {
      const resource = await store.getGitHubResource(assoc.resourceId);
      return {
        id: assoc.id,
        owner: resource?.owner ?? "",
        repo: resource?.repo ?? "",
        number: resource?.number ?? 0,
        role: assoc.role,
        workstreamKey: assoc.workstreamKey,
        expectedHeadSha: assoc.expectedHeadSha,
        active: assoc.active,
        updatedAt: assoc.updatedAt,
      };
    }),
  );

  const dispatchByAssignment = latestDispatches(outbox);
  const outcomesByAssignment = new Map<string, StoredOutcome[]>();
  for (const outcome of outcomes) {
    const grouped = outcomesByAssignment.get(outcome.assignmentId) ?? [];
    grouped.push(outcome);
    outcomesByAssignment.set(outcome.assignmentId, grouped);
  }

  const artifactRefs = new Set<string>([
    ...run.artifactRefs,
    ...assignments.flatMap((assignment) => assignment.artifactRefs),
  ]);

  return {
    ...projectRun(run),
    acceptanceCriteria: run.acceptanceCriteria,
    artifactRefs: run.artifactRefs,
    blockerRefs: run.blockerRefs,
    deadlineAt: run.deadlineAt,
    attempt,
    assignments: assignments
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((assignment) =>
        projectAssignment(
          assignment,
          dispatchByAssignment.get(assignment.id),
          outcomesByAssignment.get(assignment.id) ?? [],
        )
      ),
    outbox: outbox.map(projectOutbox),
    transitions: events.filter(isPhaseTransition).map((event) => ({
      id: event.id,
      sequence: event.sequence,
      fromPhase: event.fromPhase,
      toPhase: event.toPhase,
      actorType: event.actorType,
      actorId: event.actorId,
      occurredAt: event.occurredAt,
    })),
    events: events.filter((event) => !isPhaseTransition(event)).map((event) => ({
      id: event.id,
      sequence: event.sequence,
      type: event.eventType,
      actorType: event.actorType,
      actorId: event.actorId,
      occurredAt: event.occurredAt,
    })),
    gates,
    githubResources,
    devServerJobs: devServerJobs.map((job) => ({
      id: job.id,
      assignmentId: job.assignmentId,
      repo: job.repo,
      branch: job.branch,
      status: job.status,
      readyUrl: job.readyUrl,
      error: job.error,
      updatedAt: job.updatedAt,
    })),
    artifacts: [...artifactRefs].map((ref) => ({
      ref,
      readable: isReadableArtifactRef(run.id, ref),
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
    skillRef: assignment.skillRef,
    status: assignment.status,
    objective: assignment.objective,
    attempt: assignment.attempt,
    attemptId: assignment.attemptId,
    dependsOn: assignment.dependsOn,
    artifactRefs: assignment.artifactRefs,
    acceptanceCriteria: assignment.acceptanceCriteria,
    mutationScope: assignment.mutationScope,
    leaseOwner: assignment.leaseOwner,
    leaseExpiresAt: assignment.leaseExpiresAt,
    deadlineAt: assignment.deadlineAt,
    createdAt: assignment.createdAt,
    updatedAt: assignment.updatedAt,
    outcomes: outcomes.map((outcome) => ({
      id: outcome.id,
      action: outcome.action,
      status: outcome.status,
      reason: outcome.reason,
      blockers: outcome.blockers,
      checks: outcome.checks,
      evidenceRefs: outcome.evidenceRefs,
      artifactRefs: outcome.artifactRefs,
      createdAt: outcome.createdAt,
    })),
    dispatch: dispatch
      ? {
          status: dispatch.status,
          attempts: dispatch.attempts,
          availableAt: dispatch.availableAt,
          deliveredAt: dispatch.deliveredAt,
          lastError: dispatch.lastError,
          eventType: dispatch.eventType,
        }
      : null,
  };
}

function projectOutbox(record: PipelineOutboxRecord) {
  return {
    id: record.id,
    eventType: record.eventType,
    status: record.status,
    attempts: record.attempts,
    availableAt: record.availableAt,
    deliveredAt: record.deliveredAt,
    lastError: record.lastError,
    assignmentId: record.assignmentId,
    createdAt: record.createdAt,
  };
}

function isPhaseTransition(event: PipelineEvent): boolean {
  return (
    event.fromPhase !== null &&
    event.toPhase !== null &&
    event.fromPhase !== event.toPhase
  );
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
    // listOutbox is creation-ordered. On millisecond ties, the later record in
    // that durable order is the latest dispatch state.
    if (!current || record.createdAt >= current.createdAt) {
      result.set(record.assignmentId, record);
    }
  }
  return result;
}

function isRejectedArtifactRef(ref: string): boolean {
  const trimmed = ref.trim();
  return (
    trimmed === "" ||
    isAbsolute(trimmed) ||
    trimmed.includes("..") ||
    trimmed.startsWith("data/pipelines/")
  );
}

function isReadableArtifactRef(runId: string, ref: string): boolean {
  if (isRejectedArtifactRef(ref)) return false;
  return resolvePipelineArtifactPath({ runId, relativePath: ref }).ok;
}
