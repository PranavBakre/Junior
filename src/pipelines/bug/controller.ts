/**
 * Bug pipeline controller — typed modes, durable waits, GitHub wakes, rework.
 *
 * Soft integration: only creates BugRuns when BUG_PIPELINE_ENABLED and
 * PIPELINE_RUNTIME_MODE=active, and only on explicit !debug / !reproducer
 * starts (MVP). Does not retire pipeline-guard.
 */

import type { Clock } from "../../time/clock.ts";
import { systemClock } from "../../time/clock.ts";
import type { PipelineStore } from "../store/interface.ts";
import {
  PIPELINE_DEFINITION_VERSION,
  type AgentOutcome,
  type Assignment,
  type AttemptRevisionMember,
  type BugPhase,
  type BugRun,
  type DefaultRun,
  type PipelineEvent,
  type PipelineGate,
  type PipelineStartProvenance,
  type TransitionReceipt,
} from "../types.ts";
import {
  selectBugMode,
  suggestPhaseAfterOutcome,
  type BugMode,
  type EvidenceKind,
  type RiskClass,
} from "./definition.ts";
import {
  evidenceKindsFromRefs,
  canAdvanceToMerge,
  revisionGatesConsistent,
  validateBugOutcome,
} from "./policy.ts";
import { buildBugContext, defaultBugArtifactDir } from "./context.ts";
import {
  projectBugState,
  writeBugStateProjection,
} from "./projection.ts";
import {
  DEVSERVER_READY_CONDITION,
  requestDevServerJob,
  markDevServerJobReady,
  releaseDevServerJobOnce,
  devServerReadyOutboxPayload,
  type DevServerJobStore,
} from "../dev-server-jobs.ts";
import { invokeDevServerSlotRelease } from "../dev-server-slot-releases.ts";
import { log } from "../../logger.ts";

export type BugControllerConfig = {
  store: PipelineStore;
  /** Must implement dev-server job methods (memory/sqlite do after Phase 6). */
  jobStore?: DevServerJobStore;
  clock?: Clock;
  /** Workspace root for artifact projection paths. */
  workspaceRoot?: string;
  /** When true, write support/bugs/<id>/state.json projection. */
  writeProjection?: boolean;
  /** GitHub wake delivery enabled (also requires runtime active). */
  eventWakeEnabled?: boolean;
};

export type CreateBugRunInput = {
  channelId: string;
  threadId: string;
  /** Human or system prompt that started the run. */
  objective: string;
  /** Explicit !debug or !reproducer. */
  startKind: "debug" | "reproducer";
  /** Message ts used for idempotency. */
  messageTs: string;
  repoRefs?: string[];
  ownerAgent?: string;
  explicitMode?: BugMode | string | null;
  modeHint?: string | null;
  systemic?: boolean;
  likelyExpected?: boolean;
  riskClass?: RiskClass | null;
  deadlineAt?: number | null;
  runId?: string;
  /** Initial target: debug → lead/orchestrator; reproducer → reproducer. */
  targetAgent?: string;
  provenance?: PipelineStartProvenance;
  /** Exact authenticated default assignment being promoted. */
  sourceAssignmentId?: string;
};

export type CreateBugRunResult = {
  run: BugRun;
  assignment: Assignment;
  mode: BugMode;
  created: boolean;
  promoted?: boolean;
};

const MODE_EVENT = "bug.mode_selected";
const RISK_EVENT = "bug.risk_class";
const EVIDENCE_EVENT = "bug.evidence";

/**
 * Create a BugRun + initial assignment for an explicit start.
 * Idempotent on thread: returns existing non-terminal bug run when present.
 */
export async function createBugRun(
  config: BugControllerConfig,
  input: CreateBugRunInput,
): Promise<CreateBugRunResult> {
  const clock = config.clock ?? systemClock;
  const store = config.store;
  const now = clock.now();

  const existing = await store.getRunByThread(input.threadId);
  if (existing && existing.kind === "default" && existing.status !== "terminal") {
    return promoteDefaultToBug(config, existing, input);
  }
  if (existing && existing.kind === "bug" && existing.status !== "terminal") {
    const mode = await loadBugMode(store, existing.id);
    const assignments = await store.listAssignments(existing.id);
    const open =
      assignments.find(
        (a) =>
          a.status === "pending" ||
          a.status === "leased" ||
          a.status === "waiting",
      ) ?? assignments[assignments.length - 1];
    if (!open) {
      throw new Error(`active bug run ${existing.id} has no assignments`);
    }
    await ensureBugStartDelivery(store, existing, open, mode, input);
    return {
      run: existing,
      assignment: open,
      mode,
      created: false,
    };
  }

  const mode = selectBugMode({
    explicitMode: input.explicitMode,
    hint: input.modeHint ?? input.objective,
    systemic: input.systemic,
    likelyExpected: input.likelyExpected,
  });

  const runId = input.runId ?? crypto.randomUUID();
  const targetAgent =
    input.targetAgent ??
    (input.startKind === "reproducer" ? "reproducer" : "lead");
  const ownerAgent = input.ownerAgent ?? "lead";

  const run: BugRun = {
    id: runId,
    kind: "bug",
    definitionVersion: PIPELINE_DEFINITION_VERSION,
    channelId: input.channelId,
    threadId: input.threadId,
    phase: "intake",
    status: "active",
    ownerAgent,
    repoRefs: input.repoRefs ?? [],
    acceptanceCriteria: [],
    artifactRefs: [],
    blockerRefs: [],
    activeAttemptId: null,
    stateVersion: 0,
    deadlineAt: input.deadlineAt ?? null,
    terminalOutcome: null,
    terminalReason: null,
    createdAt: now,
    updatedAt: now,
  };

  const assignmentId = crypto.randomUUID();
  let assignment: Assignment;
  try {
    assignment = await store.createRunWithAssignment({
      run,
      assignment: {
        id: assignmentId,
        runId,
        parentAssignmentId: null,
        sourceAgent: "system",
        sourceSlackUserId: null,
        targetAgent,
        objective: input.objective,
        contextRefs: [`mode:${mode}`, `start:${input.startKind}`],
        artifactRefs: [],
        acceptanceCriteria: [],
        mutationScope: mode === "expected-behavior" ? [] : ["worktree-code"],
        dependsOn: [],
        attempt: 1,
        attemptId: null,
        candidateRevisionDigest: null,
        deadlineAt: input.deadlineAt ?? null,
        idempotencyKey: `bug-start:${input.threadId}:${input.messageTs}:${input.startKind}`,
      },
      events: [
        ...(input.provenance
          ? [
              {
                id: crypto.randomUUID(),
                runId,
                eventType: "pipeline.promoted",
                actorType: input.provenance.actorType,
                actorId: input.provenance.actorId,
                assignmentId,
                outcomeId: null,
                fromPhase: null,
                toPhase: "intake",
                payloadVersion: 1,
                payload: {
                  kind: "bug",
                  startKind: input.startKind,
                  reason: input.provenance.reason,
                  sourceMessageTs: input.provenance.sourceMessageTs,
                },
                idempotencyKey: `pipeline.promoted:${input.provenance.idempotencyKey}`,
                occurredAt: now,
                observedAt: now,
              },
            ]
          : []),
        {
          id: crypto.randomUUID(),
          runId,
          eventType: MODE_EVENT,
          actorType: "system",
          actorId: "bug-controller",
          assignmentId,
          outcomeId: null,
          fromPhase: null,
          toPhase: "intake",
          payloadVersion: 1,
          payload: {
            mode,
            startKind: input.startKind,
            riskClass: input.riskClass ?? null,
          },
          idempotencyKey: `bug.mode:${runId}`,
          occurredAt: now,
          observedAt: now,
        },
        ...(input.riskClass
          ? [
              {
                id: crypto.randomUUID(),
                runId,
                eventType: RISK_EVENT,
                actorType: "system" as const,
                actorId: "bug-controller",
                assignmentId,
                outcomeId: null,
                fromPhase: null,
                toPhase: null,
                payloadVersion: 1,
                payload: { riskClass: input.riskClass },
                idempotencyKey: `bug.risk:${runId}`,
                occurredAt: now,
                observedAt: now,
              },
            ]
          : []),
      ],
    });
  } catch (err) {
    // Only treat uniqueness / active-thread races as "reuse existing".
    const msg = err instanceof Error ? err.message : String(err);
    const isRace =
      /active pipeline run already exists|UNIQUE constraint failed.*thread_id|idx_pipeline_runs_active_thread/i.test(
        msg,
      );
    if (isRace) {
      const raced = await store.getRunByThread(input.threadId);
      if (raced && raced.kind === "bug" && raced.status !== "terminal") {
        const modeRaced = await loadBugMode(store, raced.id);
        const assignments = await store.listAssignments(raced.id);
        const open =
          assignments.find(
            (a) =>
              a.status === "pending" ||
              a.status === "leased" ||
              a.status === "waiting",
          ) ?? assignments[assignments.length - 1];
        if (open) {
          await ensureBugStartDelivery(store, raced, open, modeRaced, input);
          return {
            run: raced,
            assignment: open,
            mode: modeRaced,
            created: false,
          };
        }
      }
    }
    throw err;
  }

  // Enqueue initial dispatch.
  await ensureBugStartDelivery(store, run, assignment, mode, input);

  await maybeWriteProjection(config, run, mode, [assignment]);

  log.info(
    "bug-controller",
    `created run=${runId.slice(0, 8)} mode=${mode} start=${input.startKind} target=${targetAgent}`,
  );

  return { run, assignment, mode, created: true };
}

async function promoteDefaultToBug(
  config: BugControllerConfig,
  existing: DefaultRun,
  input: CreateBugRunInput,
): Promise<CreateBugRunResult> {
  const store = config.store;
  const now = (config.clock ?? systemClock).now();
  const sources = await store.listAssignments(existing.id);
  const source = input.sourceAssignmentId
    ? sources.find((assignment) => assignment.id === input.sourceAssignmentId)
    : sources.find((assignment) =>
        assignment.status === "pending" || assignment.status === "leased"
      );
  if (!source) throw new Error(`active default run ${existing.id} has no open assignment`);
  if (source.status !== "pending" && source.status !== "leased") {
    throw new Error(`default assignment ${source.id} cannot be promoted from ${source.status}`);
  }

  const mode = selectBugMode({
    explicitMode: input.explicitMode,
    hint: input.modeHint ?? input.objective,
    systemic: input.systemic,
    likelyExpected: input.likelyExpected,
  });
  const targetAgent = input.targetAgent ??
    (input.startKind === "reproducer" ? "reproducer" : "lead");
  const ownerAgent = input.ownerAgent ?? "lead";
  const childId = crypto.randomUUID();
  const child = {
    id: childId,
    runId: existing.id,
    parentAssignmentId: source.id,
    sourceAgent: source.targetAgent,
    sourceSlackUserId: null,
    targetAgent,
    objective: input.objective,
    contextRefs: [`mode:${mode}`, `start:${input.startKind}`],
    artifactRefs: [],
    acceptanceCriteria: existing.acceptanceCriteria,
    mutationScope: mode === "expected-behavior" ? [] : ["worktree-code"],
    dependsOn: [],
    attempt: 1,
    attemptId: null,
    candidateRevisionDigest: null,
    deadlineAt: input.deadlineAt ?? existing.deadlineAt,
    idempotencyKey: `bug-promote:${existing.id}:${input.messageTs}:${input.startKind}`,
  };
  const targetRun: BugRun = {
    ...existing,
    kind: "bug",
    definitionVersion: PIPELINE_DEFINITION_VERSION,
    phase: "intake",
    status: "active",
    ownerAgent,
    repoRefs: input.repoRefs ?? existing.repoRefs,
    deadlineAt: input.deadlineAt ?? existing.deadlineAt,
    terminalOutcome: null,
    terminalReason: null,
    updatedAt: now,
  };
  const promotionKey = input.provenance?.idempotencyKey ??
    `bug-promote:${input.threadId}:${input.messageTs}:${input.startKind}`;
  const receipt = await store.promoteDefaultRunTransaction({
    runId: existing.id,
    sourceAssignmentId: source.id,
    expectedRunVersion: existing.stateVersion,
    targetRun,
    childAssignment: child,
    reason: input.provenance?.reason ?? `upgrade default run to bug/${input.startKind}`,
    progressFingerprint: `promote:bug:${input.startKind}:${input.messageTs}`,
    actorType: input.provenance?.actorType ?? "agent",
    actorId: input.provenance?.actorId ?? ownerAgent,
    startKind: input.startKind,
    sourceMessageTs: input.messageTs,
    idempotencyKey: `pipeline.promoted:${promotionKey}`,
    seedEvents: [
      {
        id: crypto.randomUUID(),
        runId: existing.id,
        eventType: MODE_EVENT,
        actorType: "system",
        actorId: "bug-controller",
        assignmentId: childId,
        outcomeId: null,
        fromPhase: existing.phase,
        toPhase: "intake",
        payloadVersion: 1,
        payload: {
          mode,
          startKind: input.startKind,
          riskClass: input.riskClass ?? null,
        },
        idempotencyKey: `bug.mode:${existing.id}`,
        occurredAt: now,
        observedAt: now,
      },
      ...(input.riskClass
        ? [{
            id: crypto.randomUUID(),
            runId: existing.id,
            eventType: RISK_EVENT,
            actorType: "system" as const,
            actorId: "bug-controller",
            assignmentId: childId,
            outcomeId: null,
            fromPhase: existing.phase,
            toPhase: "intake",
            payloadVersion: 1,
            payload: { riskClass: input.riskClass },
            idempotencyKey: `bug.risk:${existing.id}`,
            occurredAt: now,
            observedAt: now,
          }]
        : []),
    ],
    dispatchPayload: { mode, startKind: input.startKind },
  });
  if (receipt.status !== "accepted" && receipt.status !== "duplicate") {
    throw new Error(receipt.reason ?? `bug promotion ${receipt.status}`);
  }
  const promoted = await store.getRun(existing.id);
  const assignment = receipt.assignmentId
    ? await store.getAssignment(receipt.assignmentId)
    : undefined;
  if (!promoted || promoted.kind !== "bug" || !assignment) {
    throw new Error("bug promotion committed without readable run/assignment");
  }
  await maybeWriteProjection(config, promoted, mode, [assignment]);
  return { run: promoted, assignment, mode, created: false, promoted: true };
}

async function ensureBugStartDelivery(
  store: PipelineStore,
  run: BugRun,
  assignment: Assignment,
  mode: BugMode,
  input: CreateBugRunInput,
): Promise<void> {
  await store.enqueueOutbox({
    id: crypto.randomUUID(),
    runId: run.id,
    assignmentId: assignment.id,
    eventType: "assignment.dispatch",
    payload: {
      assignmentId: assignment.id,
      targetAgent: assignment.targetAgent,
      mode,
    },
    idempotencyKey: `bug-dispatch:${assignment.idempotencyKey}`,
  });

  if (store.upsertThreadCursor) {
    await store.upsertThreadCursor({
      runId: run.id,
      channelId: run.channelId,
      threadId: run.threadId,
      lastObservedTs: input.messageTs,
      lastCatchupAt: null,
      updatedAt: Date.now(),
    });
  }
}

/**
 * Reduce an authenticated agent outcome for a bug run: mode policy, phase
 * suggestion, gate bookkeeping, and optional dev-server wait handling.
 */
export async function reduceBugOutcome(
  config: BugControllerConfig,
  input: {
    outcome: AgentOutcome;
    toPhase?: BugPhase | string;
    actorType?: "agent" | "human" | "system";
    actorId: string;
    idempotencyKey?: string;
    riskClass?: RiskClass;
  },
): Promise<TransitionReceipt & { mode?: BugMode; notes?: string[] }> {
  const store = config.store;
  const clock = config.clock ?? systemClock;
  const assignment = await store.getAssignment(input.outcome.assignmentId);
  if (!assignment) {
    return {
      status: "rejected",
      runVersion: 0,
      assignmentId: input.outcome.assignmentId,
      reason: "assignment not found",
    };
  }
  const run = await store.getRun(assignment.runId);
  if (!run || run.kind !== "bug") {
    return {
      status: "rejected",
      runVersion: run?.stateVersion ?? 0,
      assignmentId: assignment.id,
      reason: "not an active bug run",
    };
  }

  const mode = await loadBugMode(store, run.id);
  const knownEvidence = await loadKnownEvidence(store, run.id);
  const skippedEvidence = await loadSkippedEvidence(store, run.id);
  const gates = run.activeAttemptId
    ? await store.listGates(run.activeAttemptId)
    : [];

  const bugPolicy = validateBugOutcome({
    run,
    mode,
    assignment,
    outcome: input.outcome,
    knownEvidence,
    skippedEvidence,
    riskClass: input.riskClass,
    gates,
    now: clock.now(),
  });

  if (!bugPolicy.ok) {
    if (bugPolicy.escalate) {
      // Force escalate path through store.
      const escalated: AgentOutcome = {
        ...input.outcome,
        action: "escalate",
        status: "blocked",
        reason: bugPolicy.reason,
        blockers: [
          ...input.outcome.blockers,
          { kind: "human_gate", detail: bugPolicy.reason },
        ],
      };
      return store.recordOutcomeTransaction({
        outcome: escalated,
        toPhase: "needs-human",
        actorType: input.actorType ?? "agent",
        actorId: input.actorId,
        idempotencyKey: input.idempotencyKey,
      });
    }
    return {
      status: "rejected",
      runVersion: run.stateVersion,
      assignmentId: assignment.id,
      reason: bugPolicy.reason,
      mode,
    };
  }

  // Gate consistency for revision-bound completions.
  if (
    input.outcome.action === "complete" &&
    input.outcome.status === "succeeded" &&
    (run.phase === "checks" || run.phase === "validating")
  ) {
    const consistency = revisionGatesConsistent(gates);
    if (!consistency.ok) {
      return {
        status: "rejected",
        runVersion: run.stateVersion,
        assignmentId: assignment.id,
        reason: consistency.reason,
        mode,
      };
    }
  }

  let suggested =
    (input.toPhase as BugPhase | undefined) ??
    suggestPhaseAfterOutcome({
      mode,
      currentPhase: run.phase,
      outcomeStatus: input.outcome.status,
      riskClass: input.riskClass,
    }) ??
    undefined;

  // Cannot enter dev-merge / main-merge / merged without all required gates
  // passed. Main merge additionally requires a human actor.
  if (
    suggested === "dev-merge" ||
    suggested === "main-merge-gate" ||
    suggested === "merged"
  ) {
    const mergeOk = canAdvanceToMerge(gates);
    if (!mergeOk.ok) {
      return {
        status: "rejected",
        runVersion: run.stateVersion,
        assignmentId: assignment.id,
        reason: mergeOk.reason ?? "gates incomplete for merge",
        mode,
      };
    }
  }
  if (
    (suggested === "merged" || suggested === "main-merge-gate") &&
    (input.actorType ?? "agent") !== "human"
  ) {
    return {
      status: "rejected",
      runVersion: run.stateVersion,
      assignmentId: assignment.id,
      reason: "main-merge/merged requires human actor",
      mode,
    };
  }

  // Commit the outcome CAS first. Rejected CAS must have zero side effects
  // (a stale writer must not free the live validation slot). Release only for
  // committed or duplicate receipts — the leak case is a successful commit
  // path that previously forgot to release.
  const receipt = await store.recordOutcomeTransaction({
    outcome: input.outcome,
    toPhase: suggested,
    actorType: input.actorType ?? "agent",
    actorId: input.actorId,
    idempotencyKey: input.idempotencyKey,
  });

  if (
    receipt.status !== "accepted" &&
    receipt.status !== "waiting" &&
    receipt.status !== "escalated" &&
    receipt.status !== "duplicate"
  ) {
    return {
      ...receipt,
      mode,
      notes: bugPolicy.notes,
    };
  }

  // Free slots only after a successful commit (or duplicate of one).
  const shouldReleaseDevServer =
    config.jobStore &&
    (run.phase === "validating" ||
      input.outcome.wait?.conditionName === DEVSERVER_READY_CONDITION) &&
    (input.outcome.action === "complete" ||
      input.outcome.status === "failed" ||
      input.outcome.action === "escalate");
  if (shouldReleaseDevServer && config.jobStore) {
    const jobs = await config.jobStore.listDevServerJobs({ runId: run.id });
    const forAssignment = jobs.filter((j) => j.assignmentId === assignment.id);
    for (const job of forAssignment) {
      const reason =
        input.outcome.status === "failed"
          ? "fail"
          : input.outcome.action === "escalate"
            ? "cancel"
            : "complete";
      await releaseDevServerJobOnce(config.jobStore, job.id, reason);
      await invokeDevServerSlotRelease(job.id);
    }
  }

  // Record evidence from this outcome (post-commit audit).
  const newKinds = evidenceKindsFromRefs(input.outcome.evidenceRefs);
  if (newKinds.length > 0) {
    await store.appendEvent({
      id: crypto.randomUUID(),
      runId: run.id,
      eventType: EVIDENCE_EVENT,
      actorType: input.actorType ?? "agent",
      actorId: input.actorId,
      assignmentId: assignment.id,
      outcomeId: receipt.outcomeId ?? null,
      fromPhase: run.phase,
      toPhase: null,
      payloadVersion: 1,
      payload: { evidence: newKinds, refs: input.outcome.evidenceRefs },
      idempotencyKey: input.idempotencyKey
        ? `evidence:${input.idempotencyKey}`
        : `evidence:${assignment.id}:${input.outcome.progressFingerprint}`,
      occurredAt: clock.now(),
      observedAt: clock.now(),
    });
  }

  // Dev-server wait: persist job when condition is devserver.ready.
  if (
    input.outcome.action === "wait" &&
    input.outcome.wait?.conditionName === DEVSERVER_READY_CONDITION &&
    config.jobStore
  ) {
    const repo =
      run.repoRefs[0] ??
      (typeof input.outcome.artifactRefs[0] === "string"
        ? input.outcome.artifactRefs[0]
        : "unknown");
    await requestDevServerJob(
      config.jobStore,
      {
        runId: run.id,
        assignmentId: assignment.id,
        channelId: run.channelId,
        threadId: run.threadId,
        repo,
        branch: "main",
        deadlineAt: input.outcome.wait.deadlineAt,
      },
      clock,
    );
  }

  // Failed validation → rework invalidates gates on active attempt.
  if (
    input.outcome.status === "failed" &&
    (run.phase === "validating" || run.phase === "reviewing") &&
    run.activeAttemptId
  ) {
    await invalidateAttemptGates(
      store,
      run.activeAttemptId,
      "validation or review failed; rework required",
      clock.now(),
    );
  }

  const updated = await store.getRun(run.id);
  if (updated && updated.kind === "bug") {
    const assignments = await store.listAssignments(run.id);
    await maybeWriteProjection(config, updated, mode, assignments);
  }

  return {
    ...receipt,
    mode,
    notes: bugPolicy.notes,
  };
}

/**
 * When a durable dev-server job becomes ready, mark it and enqueue resume of
 * the exact waiting assignment (no Slack echo required).
 */
export async function onDevServerReady(
  config: BugControllerConfig,
  input: {
    jobId: string;
    readyUrl: string;
    pid?: number | null;
  },
): Promise<{ resumed: boolean; assignmentId?: string; reason?: string }> {
  const store = config.store;
  const jobStore = config.jobStore;
  if (!jobStore) {
    return { resumed: false, reason: "job store not configured" };
  }

  const job = await markDevServerJobReady(
    jobStore,
    input.jobId,
    input.readyUrl,
    input.pid,
  );
  if (!job) {
    return { resumed: false, reason: "job not found" };
  }

  const assignment = await store.getAssignment(job.assignmentId);
  if (!assignment) {
    return { resumed: false, reason: "assignment not found" };
  }
  if (assignment.status !== "waiting" && assignment.status !== "leased") {
    // Still enqueue resume once for pending/waiting races; skip if completed.
    if (
      assignment.status === "completed" ||
      assignment.status === "cancelled" ||
      assignment.status === "failed"
    ) {
      return {
        resumed: false,
        assignmentId: assignment.id,
        reason: `assignment already ${assignment.status}`,
      };
    }
  }

  const wake = devServerReadyOutboxPayload(job);
  await store.enqueueOutbox({
    id: crypto.randomUUID(),
    runId: job.runId,
    assignmentId: wake.assignmentId,
    eventType: wake.eventType,
    payload: wake.payload,
    idempotencyKey: wake.idempotencyKey,
  });

  // Move assignment back to pending so pump dispatches it.
  if (assignment.status === "waiting") {
    // record a synthetic continue via outbox only — pump handles resume.
  }

  log.info(
    "bug-controller",
    `devserver.ready job=${job.id.slice(0, 8)} resume asg=${job.assignmentId.slice(0, 8)} url=${input.readyUrl}`,
  );

  return { resumed: true, assignmentId: job.assignmentId };
}

/**
 * Reduce persisted GitHub semantic events into assignment wakes when
 * GITHUB_EVENT_WAKE_ENABLED. Idempotent via outbox idempotency keys.
 */
export async function reduceGitHubEventsForWakes(
  config: BugControllerConfig,
  opts: { runId?: string } = {},
): Promise<{ wakesEnqueued: number; gatesInvalidated: number }> {
  if (!config.eventWakeEnabled) {
    return { wakesEnqueued: 0, gatesInvalidated: 0 };
  }

  const store = config.store;
  const clock = config.clock ?? systemClock;
  let wakesEnqueued = 0;
  let gatesInvalidated = 0;

  const runIds: string[] = [];
  if (opts.runId) {
    runIds.push(opts.runId);
  } else {
    // Scan events is not global — callers should pass runId in production.
    // For tests, pass runId explicitly.
    return { wakesEnqueued: 0, gatesInvalidated: 0 };
  }

  for (const runId of runIds) {
    const run = await store.getRun(runId);
    if (!run || run.kind !== "bug" || run.status === "terminal") continue;

    const events = await store.listEvents(runId);
    const alreadyWoken = new Set(
      events
        .filter((e) => e.eventType === "github.wake_delivered")
        .map((e) =>
          typeof e.payload.sourceEventId === "string"
            ? e.payload.sourceEventId
            : "",
        )
        .filter(Boolean),
    );
    const githubEvents = events.filter(
      (e) =>
        e.eventType.startsWith("github.pr.") &&
        e.payload.shadow === true &&
        !alreadyWoken.has(e.id),
    );

    const assignments = await store.listAssignments(runId);
    const waiting = assignments.filter(
      (a) => a.status === "waiting" || a.status === "pending" || a.status === "leased",
    );

    for (const event of githubEvents) {
      const result = await applyGitHubEventReduction(
        store,
        run,
        event,
        waiting,
        clock.now(),
      );
      wakesEnqueued += result.wakes;
      gatesInvalidated += result.invalidated;

      // Mark delivered on the event payload by appending a companion ack event
      // (immutable events — do not rewrite). Ack is idempotent.
      await store.appendEvent({
        id: crypto.randomUUID(),
        runId,
        eventType: "github.wake_delivered",
        actorType: "system",
        actorId: "bug-controller",
        assignmentId: event.assignmentId,
        outcomeId: null,
        fromPhase: run.phase,
        toPhase: null,
        payloadVersion: 1,
        payload: {
          sourceEventId: event.id,
          fingerprint: event.payload.fingerprint ?? null,
          wakes: result.wakes,
        },
        idempotencyKey: `github.wake_delivered:${event.id}`,
        occurredAt: clock.now(),
        observedAt: clock.now(),
      });
    }
  }

  return { wakesEnqueued, gatesInvalidated };
}

async function applyGitHubEventReduction(
  store: PipelineStore,
  run: BugRun,
  event: PipelineEvent,
  waiting: Assignment[],
  now: number,
): Promise<{ wakes: number; invalidated: number }> {
  let wakes = 0;
  let invalidated = 0;
  const payload = event.payload;
  const attemptId =
    (typeof payload.attemptId === "string" ? payload.attemptId : null) ??
    run.activeAttemptId;
  const workstreamKey =
    typeof payload.workstreamKey === "string" ? payload.workstreamKey : null;
  const nextHead =
    payload.next &&
    typeof payload.next === "object" &&
    typeof (payload.next as { headRefOid?: unknown }).headRefOid === "string"
      ? ((payload.next as { headRefOid: string }).headRefOid)
      : null;

  if (event.eventType === "github.pr.head_changed" && attemptId && nextHead) {
    const members = await store.listRevisionMembers(attemptId);
    if (members.length > 0) {
      const updated: AttemptRevisionMember[] = members.map((m) => {
        if (workstreamKey && m.memberKey === workstreamKey) {
          return { ...m, headSha: nextHead };
        }
        if (!workstreamKey && members.length === 1) {
          return { ...m, headSha: nextHead };
        }
        return m;
      });
      const result = await store.replaceAttemptRevision(attemptId, updated);
      invalidated += result.invalidatedGateCount;
    }
  }

  // Exact wake only: registered assignment, attempt, role, and workstream.
  // Never fall back to "any waiting assignment" — wrong agent resume is worse
  // than a missed wake (which can be recovered on the next reconcile).
  const role = typeof payload.role === "string" ? payload.role : null;
  const resourceId =
    typeof payload.resourceId === "string" ? payload.resourceId : null;
  const target = await resolveExactWakeAssignment(store, {
    run,
    event,
    waiting,
    attemptId,
    workstreamKey,
    role,
    resourceId,
  });

  if (target) {
    const idempotencyKey = `github.wake:${event.id}:${target.id}`;
    await store.enqueueOutbox({
      id: crypto.randomUUID(),
      runId: run.id,
      assignmentId: target.id,
      eventType: "assignment.resume",
      payload: {
        reason: event.eventType,
        sourceEventId: event.id,
        role,
        headSha: nextHead,
        fingerprint: payload.fingerprint ?? null,
      },
      idempotencyKey,
    });
    wakes += 1;
  }

  void now;
  return { wakes, invalidated };
}

/**
 * Resolve the single assignment that should wake for a GitHub event.
 * Returns null unless there is an exact, unambiguous match.
 */
export async function resolveExactWakeAssignment(
  store: PipelineStore,
  args: {
    run: BugRun;
    event: PipelineEvent;
    waiting: Assignment[];
    attemptId: string | null;
    workstreamKey: string | null;
    role: string | null;
    resourceId: string | null;
  },
): Promise<Assignment | null> {
  const { event, waiting, attemptId, workstreamKey, role, resourceId, run } =
    args;
  if (waiting.length === 0) return null;

  const waitingById = new Map(waiting.map((a) => [a.id, a]));

  // 1) Event pins an assignment id — only that assignment, and only if waiting.
  if (event.assignmentId) {
    return waitingById.get(event.assignmentId) ?? null;
  }

  // 2) Resource association pins registered_by_assignment_id (+ role/attempt/workstream).
  if (resourceId) {
    const assocs = await store.listAssociationsForResource(resourceId, true);
    const runAssocs = assocs.filter((a) => a.runId === run.id && a.active);
    const matched = runAssocs.filter((a) => {
      if (role && a.role !== role) return false;
      if (workstreamKey && a.workstreamKey !== workstreamKey) return false;
      if (attemptId && a.attemptId && a.attemptId !== attemptId) return false;
      return true;
    });
    if (matched.length === 1 && matched[0]!.registeredByAssignmentId) {
      return waitingById.get(matched[0]!.registeredByAssignmentId) ?? null;
    }
    // Ambiguous or missing registration — do not guess.
    if (matched.length !== 1) return null;
  }

  // 3) Strict structural filter: attempt + event-type-appropriate agent.
  // Require attempt match when the event carries one; require exactly one candidate.
  const candidates = waiting.filter((a) => {
    if (attemptId) {
      if (a.attemptId && a.attemptId !== attemptId) return false;
      // Prefer bindings that share the attempt; allow null attempt only when
      // no waiting assignment is attempt-bound (legacy single-assignment runs).
      if (
        a.attemptId == null &&
        waiting.some((w) => w.attemptId === attemptId)
      ) {
        return false;
      }
    }
    return assignmentMatchesGitHubEventType(a, event.eventType, role, run);
  });

  if (candidates.length === 1) return candidates[0]!;
  return null;
}

function assignmentMatchesGitHubEventType(
  assignment: Assignment,
  eventType: string,
  role: string | null,
  run: BugRun,
): boolean {
  const objective = assignment.objective.toLowerCase();
  switch (eventType) {
    case "github.pr.checks_changed":
      return (
        objective.includes("check") ||
        assignment.targetAgent === "lead" ||
        assignment.targetAgent === "default"
      );
    case "github.pr.merged":
      if (role === "dev-pr") {
        return (
          objective.includes("dev") ||
          run.phase === "dev-merge" ||
          assignment.targetAgent === "lead" ||
          assignment.targetAgent === "default"
        );
      }
      if (role === "main-pr") {
        return (
          objective.includes("main") ||
          run.phase === "main-merge-gate" ||
          assignment.targetAgent === "lead" ||
          assignment.targetAgent === "default"
        );
      }
      return (
        assignment.targetAgent === "lead" || assignment.targetAgent === "default"
      );
    case "github.pr.review_decision_changed":
      return (
        assignment.targetAgent === "review" ||
        objective.includes("review")
      );
    case "github.pr.head_changed":
      // Head changes invalidate gates; resume only when the waiter is clearly
      // bound to review/validation on this PR — never builders/dev-server by default.
      return (
        assignment.targetAgent === "review" ||
        assignment.targetAgent === "reproducer" ||
        objective.includes("review") ||
        objective.includes("validat")
      );
    case "github.pr.closed":
    case "github.pr.reopened":
    case "github.pr.base_changed":
      return (
        assignment.targetAgent === "lead" ||
        assignment.targetAgent === "default" ||
        assignment.targetAgent === "review"
      );
    default:
      return false;
  }
}

/**
 * Bind review + validation + checks gates to one attempt revision vector.
 */
export async function ensureRevisionBoundGates(
  store: PipelineStore,
  input: {
    runId: string;
    attemptId: string;
    subjectSha: string;
    memberKey?: string | null;
    agentName?: string | null;
  },
): Promise<PipelineGate[]> {
  const now = Date.now();
  const kinds = ["review", "validation", "checks"] as const;
  const gates: PipelineGate[] = [];
  for (const gateKind of kinds) {
    const gate: PipelineGate = {
      id: `${input.attemptId}:${gateKind}:${input.memberKey ?? "aggregate"}`,
      runId: input.runId,
      attemptId: input.attemptId,
      memberKey: input.memberKey ?? null,
      githubResourceId: null,
      gateKind,
      status: "pending",
      subjectSha: input.subjectSha,
      evidenceRef: null,
      provider: null,
      model: null,
      agentName: input.agentName ?? null,
      updatedAt: now,
    };
    await store.upsertGate(gate);
    gates.push(gate);
  }
  return gates;
}

export async function loadBugMode(
  store: PipelineStore,
  runId: string,
): Promise<BugMode> {
  const events = await store.listEvents(runId);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.eventType === MODE_EVENT) {
      const mode = e.payload.mode;
      if (
        mode === "expected-behavior" ||
        mode === "focused-debug" ||
        mode === "full-investigation"
      ) {
        return mode;
      }
    }
  }
  // Fallback: contextRefs on first assignment.
  const assignments = await store.listAssignments(runId);
  for (const a of assignments) {
    for (const ref of a.contextRefs) {
      if (ref.startsWith("mode:")) {
        const m = ref.slice("mode:".length);
        if (
          m === "expected-behavior" ||
          m === "focused-debug" ||
          m === "full-investigation"
        ) {
          return m;
        }
      }
    }
  }
  return "focused-debug";
}

async function loadKnownEvidence(
  store: PipelineStore,
  runId: string,
): Promise<EvidenceKind[]> {
  const events = await store.listEvents(runId);
  const kinds = new Set<EvidenceKind>();
  for (const e of events) {
    if (e.eventType !== EVIDENCE_EVENT) continue;
    const list = e.payload.evidence;
    if (Array.isArray(list)) {
      for (const k of list) {
        if (typeof k === "string") kinds.add(k as EvidenceKind);
      }
    }
  }
  // Seed report evidence on every run.
  kinds.add("report");
  return [...kinds];
}

async function loadSkippedEvidence(
  store: PipelineStore,
  runId: string,
): Promise<Array<{ kind: EvidenceKind; reason: string }>> {
  const events = await store.listEvents(runId);
  const out: Array<{ kind: EvidenceKind; reason: string }> = [];
  for (const e of events) {
    if (e.eventType !== "bug.evidence_skipped") continue;
    const kind = e.payload.kind;
    const reason = e.payload.reason;
    if (typeof kind === "string" && typeof reason === "string") {
      out.push({ kind: kind as EvidenceKind, reason });
    }
  }
  return out;
}

async function invalidateAttemptGates(
  store: PipelineStore,
  attemptId: string,
  reason: string,
  now: number,
): Promise<void> {
  const gates = await store.listGates(attemptId);
  for (const g of gates) {
    if (g.status === "invalidated") continue;
    await store.upsertGate({
      ...g,
      status: "invalidated",
      evidenceRef: reason,
      updatedAt: now,
    });
  }
  // Also invalidate via revision no-op? Prefer explicit gate invalidation.
}

async function maybeWriteProjection(
  config: BugControllerConfig,
  run: BugRun,
  mode: BugMode,
  assignments: Assignment[],
): Promise<void> {
  if (!config.writeProjection) return;
  const root = config.workspaceRoot ?? process.cwd();
  const dir = defaultBugArtifactDir(root, run.id);
  let revisionMembers: AttemptRevisionMember[] = [];
  let revisionDigest: string | null = null;
  let gates: PipelineGate[] = [];
  if (run.activeAttemptId) {
    revisionMembers = await config.store.listRevisionMembers(
      run.activeAttemptId,
    );
    const attempt = await config.store.getAttempt(run.activeAttemptId);
    revisionDigest = attempt?.revisionDigest ?? null;
    gates = await config.store.listGates(run.activeAttemptId);
  }
  const projection = projectBugState({
    run,
    mode,
    assignments,
    revisionMembers,
    revisionDigest,
    gates,
    knownEvidence: await loadKnownEvidence(config.store, run.id),
    now: (config.clock ?? systemClock).now(),
  });
  try {
    writeBugStateProjection(dir, projection);
  } catch (err) {
    log.warn(
      "bug-controller",
      `projection write failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Build injection block for dispatch when assignment is under an active bug run.
 */
export async function bugContextForAssignment(
  config: BugControllerConfig,
  run: BugRun,
  assignment: Assignment,
): Promise<string> {
  const mode = await loadBugMode(config.store, run.id);
  const root = config.workspaceRoot ?? process.cwd();
  let revisionMembers: AttemptRevisionMember[] = [];
  let revisionDigest: string | null = assignment.candidateRevisionDigest;
  let gates: PipelineGate[] = [];
  const attemptId = assignment.attemptId ?? run.activeAttemptId;
  if (attemptId) {
    revisionMembers = await config.store.listRevisionMembers(attemptId);
    const attempt = await config.store.getAttempt(attemptId);
    revisionDigest = attempt?.revisionDigest ?? revisionDigest;
    gates = await config.store.listGates(attemptId);
  }
  return buildBugContext({
    run,
    assignment,
    mode,
    artifactDir: defaultBugArtifactDir(root, run.id),
    revisionMembers,
    revisionDigest,
    gates,
  });
}

/**
 * Soft gate used by router: may we create a BugRun for this explicit start?
 */
export function shouldCreateBugRun(flags: {
  bugPipelineEnabled: boolean;
  runtimeMode: "off" | "shadow" | "active";
  /** Explicit !debug or !reproducer only for MVP. */
  explicitStart: boolean;
}): boolean {
  if (!flags.bugPipelineEnabled) return false;
  if (flags.runtimeMode !== "active") return false;
  return flags.explicitStart;
}

/**
 * Soft gate for durable dev-server path vs legacy 10-min sleep.
 */
export function shouldUseDurableDevServer(flags: {
  bugPipelineEnabled: boolean;
  runtimeMode: "off" | "shadow" | "active";
  hasActiveBugRun: boolean;
}): boolean {
  return (
    flags.bugPipelineEnabled &&
    flags.runtimeMode === "active" &&
    flags.hasActiveBugRun
  );
}
