/**
 * Product pipeline controller — discovery → build → review ↔ rework → human merge.
 *
 * Soft integration: only creates ProductRuns when PRODUCT_PIPELINE_ENABLED and
 * PIPELINE_RUNTIME_MODE=active, and only on explicit !pm / !build starts (MVP).
 */

import type { Clock } from "../../time/clock.ts";
import { systemClock } from "../../time/clock.ts";
import type { PipelineStore } from "../store/interface.ts";
import {
  PIPELINE_DEFINITION_VERSION,
  type AgentOutcome,
  type Assignment,
  type AttemptRevisionMember,
  type DefaultRun,
  type PipelineGate,
  type PipelineStartProvenance,
  type ProductPhase,
  type ProductRun,
  type TransitionReceipt,
} from "../types.ts";
import {
  detectFullStackIntent,
  initialProductStart,
  isProductBuilderAgent,
  suggestPhaseAfterOutcome,
  type SkipStageReason,
} from "./definition.ts";
import {
  fanOutComplete,
  prRegistrationKey,
  reviewFindingFingerprint,
  revisionGatesConsistent,
  validateProductOutcome,
} from "./policy.ts";
import {
  buildProductContext,
  defaultProductArtifactDir,
} from "./context.ts";
import { log } from "../../logger.ts";

export type ProductControllerConfig = {
  store: PipelineStore;
  clock?: Clock;
  /** Workspace root for artifact paths. */
  workspaceRoot?: string;
};

export type CreateProductRunInput = {
  channelId: string;
  threadId: string;
  objective: string;
  /** Explicit !pm or !build. */
  startKind: "pm" | "build";
  /** Message ts used for idempotency. */
  messageTs: string;
  repoRefs?: string[];
  ownerAgent?: string;
  forceDiscovery?: boolean;
  deadlineAt?: number | null;
  runId?: string;
  targetAgent?: string;
  acceptanceCriteria?: string[];
  provenance?: PipelineStartProvenance;
  /** Exact authenticated default assignment being promoted. */
  sourceAssignmentId?: string;
  /** Orchestrator-declared implementation scope; preferred over inference. */
  requiredWorkstreams?: Array<"backend" | "frontend">;
};

export type CreateProductRunResult = {
  run: ProductRun;
  assignment: Assignment;
  skipReasons: SkipStageReason[];
  created: boolean;
  promoted?: boolean;
};

const SKIP_EVENT = "product.stages_skipped";
const FANOUT_EVENT = "product.fanout";
const REVIEW_FINDINGS_EVENT = "product.review_findings";
const WORKSTREAM_EVENT = "product.workstreams";

/**
 * Create a ProductRun + initial assignment for an explicit !pm / !build start.
 * Idempotent on thread: returns existing non-terminal product run when present.
 */
export async function createProductRun(
  config: ProductControllerConfig,
  input: CreateProductRunInput,
): Promise<CreateProductRunResult> {
  const clock = config.clock ?? systemClock;
  const store = config.store;
  const now = clock.now();

  const existing = await store.getRunByThread(input.threadId);
  if (existing && existing.kind === "default" && existing.status !== "terminal") {
    return promoteDefaultToProduct(config, existing, input);
  }
  if (
    existing &&
    existing.kind === "product" &&
    existing.status !== "terminal"
  ) {
    const skipReasons = await loadSkipReasons(store, existing.id);
    let assignments = await store.listAssignments(existing.id);
    const existingWorkstreams = await loadWorkstreams(store, existing.id);
    if (input.startKind === "build" && existingWorkstreams.length > 1) {
      const parent = assignments.find((assignment) =>
        assignment.parentAssignmentId === null
      );
      if (parent) {
        await fanOutBuilders(config, {
          runId: existing.id,
          parentAssignmentId: parent.id,
          expectedRunVersion: existing.stateVersion,
          sourceAgent: input.ownerAgent ?? existing.ownerAgent,
          objective: input.objective,
          idempotencyKey: `product-start-fanout:${input.threadId}:${input.messageTs}`,
          workstreams: existingWorkstreams.map((workstream) => ({
            agent: workstream === "frontend" ? "frontend" as const : "build" as const,
            workstreamKey: workstream,
          })),
        });
        assignments = await store.listAssignments(existing.id);
      }
    }
    const open =
      assignments.find(
        (a) =>
          a.status === "pending" ||
          a.status === "leased" ||
          a.status === "waiting",
      ) ?? assignments[assignments.length - 1];
    if (!open) {
      throw new Error(`active product run ${existing.id} has no assignments`);
    }
    if (existingWorkstreams.length <= 1) {
      await ensureProductStartDelivery(store, existing, open, input);
    }
    return {
      run: existing,
      assignment: open,
      skipReasons,
      created: false,
    };
  }

  const start = initialProductStart({
    startKind: input.startKind,
    objective: input.objective,
    forceDiscovery: input.forceDiscovery,
  });
  const requestedTargetAgent = input.targetAgent ?? start.targetAgent;
  const ownerAgent = input.ownerAgent ?? start.ownerAgent;
  const workstreams = input.startKind === "build"
    ? inferProductWorkstreams(
        input.objective,
        input.repoRefs ?? [],
        input.requiredWorkstreams,
      )
    : [];
  const fullStack = workstreams.length > 1;
  // Multi-stream starts use a coordinator parent and fan out immediately.
  // Single-stream starts retain the existing phase progression while routing
  // directly to the correct specialist.
  const targetAgent = fullStack
    ? ownerAgent
    : workstreams[0] === "frontend"
      ? "frontend"
      : requestedTargetAgent;
  const runId = input.runId ?? crypto.randomUUID();

  const run: ProductRun = {
    id: runId,
    kind: "product",
    definitionVersion: PIPELINE_DEFINITION_VERSION,
    channelId: input.channelId,
    threadId: input.threadId,
    phase: start.phase,
    status: "active",
    ownerAgent,
    repoRefs: input.repoRefs ?? [],
    acceptanceCriteria: input.acceptanceCriteria ?? [],
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

  const mutationScope =
    targetAgent === "build" || targetAgent === "frontend"
      ? ["worktree-code"]
      : targetAgent === "pm" || targetAgent === "architect"
        ? ["pipeline-artifact"]
        : [];

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
        contextRefs: [
          `start:${input.startKind}`,
          `phase:${start.phase}`,
          ...(fullStack ? ["fullstack:true"] : []),
          ...start.skipReasons.map((s) => `skip:${s.stage}`),
        ],
        artifactRefs: [],
        acceptanceCriteria: input.acceptanceCriteria ?? [],
        mutationScope,
        dependsOn: [],
        attempt: 1,
        attemptId: null,
        candidateRevisionDigest: null,
        deadlineAt: input.deadlineAt ?? null,
        idempotencyKey: `product-start:${input.threadId}:${input.messageTs}:${input.startKind}`,
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
                toPhase: start.phase,
                payloadVersion: 1,
                payload: {
                  kind: "product",
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
        ...(start.skipReasons.length > 0
          ? [
              {
                id: crypto.randomUUID(),
                runId,
                eventType: SKIP_EVENT,
                actorType: "system" as const,
                actorId: "product-controller",
                assignmentId,
                outcomeId: null,
                fromPhase: null,
                toPhase: start.phase,
                payloadVersion: 1,
                payload: { reasons: start.skipReasons },
                idempotencyKey: `product.skip:${runId}`,
                occurredAt: now,
                observedAt: now,
              },
            ]
          : []),
      ],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isRace =
      /active pipeline run already exists|UNIQUE constraint failed.*thread_id|idx_pipeline_runs_active_thread/i.test(
        msg,
      );
    if (isRace) {
      const raced = await store.getRunByThread(input.threadId);
      if (raced && raced.kind === "product" && raced.status !== "terminal") {
        const assignments = await store.listAssignments(raced.id);
        const open =
          assignments.find(
            (a) =>
              a.status === "pending" ||
              a.status === "leased" ||
              a.status === "waiting",
          ) ?? assignments[assignments.length - 1];
        if (open) {
          await ensureProductStartDelivery(store, raced, open, input);
          return {
            run: raced,
            assignment: open,
            skipReasons: start.skipReasons,
            created: false,
          };
        }
      }
    }
    throw err;
  }

  if (workstreams.length > 0) {
    await store.appendEvent({
      id: crypto.randomUUID(),
      runId,
      eventType: WORKSTREAM_EVENT,
      actorType: "system",
      actorId: "product-controller",
      assignmentId: assignment.id,
      outcomeId: null,
      fromPhase: null,
      toPhase: start.phase,
      payloadVersion: 1,
      payload: { workstreams, fullStack },
      idempotencyKey: `product.workstreams:${runId}`,
      occurredAt: now,
      observedAt: now,
    });
  }

  let returnedRun = run;
  if (input.startKind === "build" && fullStack) {
    const fanout = await fanOutBuilders(config, {
      runId,
      parentAssignmentId: assignment.id,
      expectedRunVersion: run.stateVersion,
      sourceAgent: ownerAgent,
      objective: input.objective,
      idempotencyKey: `product-start-fanout:${input.threadId}:${input.messageTs}`,
      workstreams: workstreams.map((workstream) => ({
        agent: workstream === "frontend" ? "frontend" as const : "build" as const,
        workstreamKey: workstream,
      })),
    });
    if (fanout.receipt.status === "rejected" || fanout.assignments.length === 0) {
      throw new Error(
        `product build fan-out failed: ${fanout.receipt.reason ?? fanout.receipt.status}`,
      );
    }
    assignment = fanout.assignments[0]!;
    const advancedRun = await store.getRun(runId);
    if (advancedRun?.kind === "product") returnedRun = advancedRun;
  } else {
    await ensureProductStartDelivery(store, run, assignment, input);
  }

  log.info(
    "product-controller",
    `created run=${runId.slice(0, 8)} start=${input.startKind} phase=${returnedRun.phase} target=${assignment.targetAgent} skip=${start.skipReasons.length}`,
  );

  return {
    run: returnedRun,
    assignment,
    skipReasons: start.skipReasons,
    created: true,
  };
}

async function promoteDefaultToProduct(
  config: ProductControllerConfig,
  existing: DefaultRun,
  input: CreateProductRunInput,
): Promise<CreateProductRunResult> {
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

  const start = initialProductStart({
    startKind: input.startKind,
    objective: input.objective,
    forceDiscovery: input.forceDiscovery,
  });
  const ownerAgent = input.ownerAgent ?? start.ownerAgent;
  const workstreams = input.startKind === "build"
    ? inferProductWorkstreams(
        input.objective,
        input.repoRefs ?? existing.repoRefs,
        input.requiredWorkstreams,
      )
    : [];
  const targets = workstreams.length > 0
    ? workstreams.map((workstream) => ({
        agent: workstream === "frontend" ? "frontend" : "build",
        workstream,
      }))
    : [{ agent: input.targetAgent ?? start.targetAgent, workstream: null }];
  const makeChild = (
    target: (typeof targets)[number],
    index: number,
  ) => ({
    id: crypto.randomUUID(),
    runId: existing.id,
    parentAssignmentId: source.id,
    sourceAgent: source.targetAgent,
    sourceSlackUserId: null,
    targetAgent: target.agent,
    objective: target.workstream
      ? `${input.objective} [${target.workstream}]`
      : input.objective,
    contextRefs: [
      `start:${input.startKind}`,
      `phase:${start.phase}`,
      ...(target.workstream ? [`workstream:${target.workstream}`] : []),
      ...(targets.length > 1 ? ["fanout:true"] : []),
      ...start.skipReasons.map((reason) => `skip:${reason.stage}`),
    ],
    artifactRefs: [],
    acceptanceCriteria: input.acceptanceCriteria ?? existing.acceptanceCriteria,
    mutationScope:
      target.agent === "build" || target.agent === "frontend"
        ? ["worktree-code"]
        : target.agent === "pm" || target.agent === "architect"
          ? ["pipeline-artifact"]
          : [],
    dependsOn: [],
    attempt: 1,
    attemptId: null,
    candidateRevisionDigest: null,
    deadlineAt: input.deadlineAt ?? existing.deadlineAt,
    idempotencyKey: `product-promote:${existing.id}:${input.messageTs}:${input.startKind}:${target.workstream ?? index}`,
  });
  const children = targets.map(makeChild);
  const targetRun: ProductRun = {
    ...existing,
    kind: "product",
    definitionVersion: PIPELINE_DEFINITION_VERSION,
    phase: start.phase,
    status: "active",
    ownerAgent,
    repoRefs: input.repoRefs ?? existing.repoRefs,
    acceptanceCriteria: input.acceptanceCriteria ?? existing.acceptanceCriteria,
    deadlineAt: input.deadlineAt ?? existing.deadlineAt,
    terminalOutcome: null,
    terminalReason: null,
    updatedAt: now,
  };
  const promotionKey = input.provenance?.idempotencyKey ??
    `product-promote:${input.threadId}:${input.messageTs}:${input.startKind}`;
  const seedEvents = [
    ...(start.skipReasons.length > 0
      ? [{
          id: crypto.randomUUID(),
          runId: existing.id,
          eventType: SKIP_EVENT,
          actorType: "system" as const,
          actorId: "product-controller",
          assignmentId: children[0]!.id,
          outcomeId: null,
          fromPhase: existing.phase,
          toPhase: start.phase,
          payloadVersion: 1,
          payload: { reasons: start.skipReasons },
          idempotencyKey: `product.skip:${existing.id}`,
          occurredAt: now,
          observedAt: now,
        }]
      : []),
    ...(workstreams.length > 0
      ? [{
          id: crypto.randomUUID(),
          runId: existing.id,
          eventType: WORKSTREAM_EVENT,
          actorType: "system" as const,
          actorId: "product-controller",
          assignmentId: children[0]!.id,
          outcomeId: null,
          fromPhase: existing.phase,
          toPhase: start.phase,
          payloadVersion: 1,
          payload: { workstreams, fullStack: workstreams.length > 1 },
          idempotencyKey: `product.workstreams:${existing.id}`,
          occurredAt: now,
          observedAt: now,
        }]
      : []),
  ];
  const receipt = await store.promoteDefaultRunTransaction({
    runId: existing.id,
    sourceAssignmentId: source.id,
    expectedRunVersion: existing.stateVersion,
    targetRun,
    childAssignment: children[0]!,
    additionalAssignments: children.slice(1),
    reason: input.provenance?.reason ?? `upgrade default run to product/${input.startKind}`,
    progressFingerprint: `promote:product:${input.startKind}:${input.messageTs}`,
    actorType: input.provenance?.actorType ?? "agent",
    actorId: input.provenance?.actorId ?? ownerAgent,
    startKind: input.startKind,
    sourceMessageTs: input.messageTs,
    idempotencyKey: `pipeline.promoted:${promotionKey}`,
    seedEvents,
    dispatchPayload: {
      startKind: input.startKind,
      phase: start.phase,
      workstreamKey: targets[0]!.workstream,
    },
    additionalDispatchPayloads: targets.slice(1).map((target) => ({
      startKind: input.startKind,
      phase: start.phase,
      workstreamKey: target.workstream,
    })),
  });
  if (receipt.status !== "accepted" && receipt.status !== "duplicate") {
    throw new Error(receipt.reason ?? `product promotion ${receipt.status}`);
  }
  const promoted = await store.getRun(existing.id);
  const assignment = receipt.assignmentId
    ? await store.getAssignment(receipt.assignmentId)
    : undefined;
  if (!promoted || promoted.kind !== "product" || !assignment) {
    throw new Error("product promotion committed without readable run/assignment");
  }
  return {
    run: promoted,
    assignment,
    skipReasons: start.skipReasons,
    created: false,
    promoted: true,
  };
}

export function inferProductWorkstreams(
  objective: string,
  repoRefs: string[],
  explicit?: Array<"backend" | "frontend">,
): Array<"backend" | "frontend"> {
  if (explicit && explicit.length > 0) {
    return [...new Set(explicit)];
  }
  const repos = repoRefs.map((repoRef) => repoRef.toLowerCase());
  const hasFrontendRepo = repos.some((repo) =>
    /(?:^|[-_/])(client|frontend|web|admin)(?:$|[-_/])/.test(repo)
  );
  const hasBackendRepo = repos.some((repo) =>
    /(?:^|[-_/])(backend|api|service|server)(?:$|[-_/])/.test(repo)
  );
  if (hasFrontendRepo && hasBackendRepo) return ["backend", "frontend"];
  if (hasFrontendRepo) return ["frontend"];
  if (hasBackendRepo) return ["backend"];

  const text = objective.toLowerCase();
  if (detectFullStackIntent(objective) || /\bfull[ -]?stack\b/.test(text)) {
    return ["backend", "frontend"];
  }
  if (/\b(ui|ux|frontend|client|react|css|component|page|screen)\b/.test(text)) {
    return ["frontend"];
  }
  return ["backend"];
}

async function ensureProductStartDelivery(
  store: PipelineStore,
  run: ProductRun,
  assignment: Assignment,
  input: CreateProductRunInput,
): Promise<void> {
  await store.enqueueOutbox({
    id: crypto.randomUUID(),
    runId: run.id,
    assignmentId: assignment.id,
    eventType: "assignment.dispatch",
    payload: {
      assignmentId: assignment.id,
      targetAgent: assignment.targetAgent,
      startKind: input.startKind,
      phase: run.phase,
    },
    idempotencyKey: `product-dispatch:${assignment.idempotencyKey}`,
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
 * Reduce an authenticated agent outcome for a product run: skip/fan-out policy,
 * phase suggestion, gate bookkeeping, review-finding loop detection.
 */
export async function reduceProductOutcome(
  config: ProductControllerConfig,
  input: {
    outcome: AgentOutcome;
    toPhase?: ProductPhase | string;
    actorType?: "agent" | "human" | "system";
    actorId: string;
    idempotencyKey?: string;
    /** Optional review verdict for reviewing phase. */
    reviewVerdict?: "approved" | "changes_requested" | "comment" | null;
    /** When true, treat product decision as still open. */
    needsProductDecision?: boolean;
  },
): Promise<
  TransitionReceipt & { notes?: string[]; skipReasons?: SkipStageReason[] }
> {
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
  if (!run || run.kind !== "product") {
    return {
      status: "rejected",
      runVersion: run?.stateVersion ?? 0,
      assignmentId: assignment.id,
      reason: "not an active product run",
    };
  }

  // Human-only ship: ready-for-human-merge → shipped.
  if (
    input.toPhase === "shipped" ||
    (run.phase === "ready-for-human-merge" &&
      input.outcome.action === "complete" &&
      input.outcome.status === "succeeded" &&
      input.outcome.evidenceRefs.some((r) => r.startsWith("human-merge:")))
  ) {
    if (input.actorType !== "human") {
      return {
        status: "rejected",
        runVersion: run.stateVersion,
        assignmentId: assignment.id,
        reason: "shipped requires human actor",
      };
    }
  }

  const allAssignments = await store.listAssignments(run.id);
  const builders = allAssignments.filter((a) =>
    isProductBuilderAgent(a.targetAgent),
  );
  const pendingBuilders = builders.filter(
    (a) =>
      a.id !== assignment.id &&
      (a.status === "pending" ||
        a.status === "leased" ||
        a.status === "waiting"),
  );
  const completedBuilders = builders.filter((a) => a.status === "completed");

  const skipReasons = await loadSkipReasons(store, run.id);
  const revisionMembers = run.activeAttemptId
    ? await store.listRevisionMembers(run.activeAttemptId)
    : [];
  const activeAttempt = run.activeAttemptId
    ? await store.getAttempt(run.activeAttemptId)
    : undefined;
  const registeredPrKeys = await loadRegisteredPrKeys(
    store,
    run.id,
    run.activeAttemptId,
    revisionMembers.map((member) => member.headSha),
  );
  const recentReviewFingerprints = await loadReviewFingerprints(store, run.id);
  const gates = run.activeAttemptId
    ? await store.listGates(run.activeAttemptId)
    : [];
  const workstreams = await loadWorkstreams(store, run.id);

  const productPolicy = validateProductOutcome({
    run,
    assignment,
    outcome: input.outcome,
    pendingBuilderAssignments: pendingBuilders,
    completedBuilderAssignments: completedBuilders,
    registeredPrKeys,
    recentReviewFingerprints,
    skipReasons,
    gates,
    now: clock.now(),
  });

  if (!productPolicy.ok) {
    if (productPolicy.escalate) {
      const escalated: AgentOutcome = {
        ...input.outcome,
        action: "escalate",
        status: "blocked",
        reason: productPolicy.reason,
        blockers: [
          ...input.outcome.blockers,
          { kind: "no_progress", detail: productPolicy.reason },
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
      reason: productPolicy.reason,
    };
  }

  // Gate consistency for revision-bound completions.
  if (
    input.outcome.action === "complete" &&
    input.outcome.status === "succeeded" &&
    (run.phase === "aggregate-verification" ||
      run.phase === "approved" ||
      run.phase === "ready-for-human-merge")
  ) {
    const consistency = revisionGatesConsistent(
      gates,
      revisionMembers,
      activeAttempt?.revisionDigest ?? null,
    );
    if (!consistency.ok) {
      return {
        status: "rejected",
        runVersion: run.stateVersion,
        assignmentId: assignment.id,
        reason: consistency.reason,
      };
    }
  }

  // Record review findings fingerprint for loop detection.
  if (run.phase === "reviewing") {
    const fp = reviewFindingFingerprint(input.outcome);
    if (fp) {
      await store.appendEvent({
        id: crypto.randomUUID(),
        runId: run.id,
        eventType: REVIEW_FINDINGS_EVENT,
        actorType: input.actorType ?? "agent",
        actorId: input.actorId,
        assignmentId: assignment.id,
        outcomeId: null,
        fromPhase: run.phase,
        toPhase: null,
        payloadVersion: 1,
        payload: { fingerprint: fp, status: input.outcome.status },
        idempotencyKey: input.idempotencyKey
          ? `review-fp:${input.idempotencyKey}`
          : `review-fp:${assignment.id}:${fp}`,
        occurredAt: clock.now(),
        observedAt: clock.now(),
      });
    }
  }

  // Fan-out bookkeeping when a builder completes.
  const buildersDone = fanOutComplete(builders, assignment.id);
  if (
    isProductBuilderAgent(assignment.targetAgent) &&
    input.outcome.action === "complete" &&
    (input.outcome.status === "succeeded" || input.outcome.status === "failed")
  ) {
    await store.appendEvent({
      id: crypto.randomUUID(),
      runId: run.id,
      eventType: FANOUT_EVENT,
      actorType: input.actorType ?? "agent",
      actorId: input.actorId,
      assignmentId: assignment.id,
      outcomeId: null,
      fromPhase: run.phase,
      toPhase: null,
      payloadVersion: 1,
      payload: {
        builder: assignment.targetAgent,
        status: input.outcome.status,
        allDone: buildersDone,
      },
      idempotencyKey: input.idempotencyKey
        ? `fanout:${input.idempotencyKey}`
        : `fanout:${assignment.id}:${input.outcome.progressFingerprint}`,
      occurredAt: clock.now(),
      observedAt: clock.now(),
    });
  }

  const reviewVerdict =
    input.reviewVerdict ??
    inferReviewVerdict(input.outcome, run.phase);
  const devVerificationFailed = isDevVerificationRegression(input.outcome);

  let suggested: ProductPhase | undefined =
    (input.toPhase as ProductPhase | undefined) ??
    suggestPhaseAfterOutcome({
      currentPhase: run.phase,
      outcomeStatus: input.outcome.status,
      outcomeAction: input.outcome.action,
      reviewVerdict,
      allBuildersDone: buildersDone,
      // Every required workstream must have a registered PR. A non-empty
      // registry must NOT short-circuit missing workstreams.
      allPrsRegistered:
        workstreams.length === 0 ||
        workstreams.every((w) =>
          registeredPrKeys.some((k) => k.includes(`:${w}`) || k.endsWith(w)),
        ),
      needsProductDecision: input.needsProductDecision === true,
      devVerificationFailed,
    }) ??
    undefined;

  // Keep building while other fan-out builders are open.
  if (
    run.phase === "building" &&
    isProductBuilderAgent(assignment.targetAgent) &&
    input.outcome.action === "complete" &&
    input.outcome.status === "succeeded" &&
    !buildersDone
  ) {
    suggested = "building";
  }

  // Explicit toPhase from caller wins when provided.
  if (input.toPhase) {
    suggested = input.toPhase as ProductPhase;
  }

  const reopensApprovedCandidate =
    suggested === "fixing" &&
    (run.phase === "approved" || run.phase === "ready-for-human-merge");
  if (reopensApprovedCandidate && !devVerificationFailed) {
    return {
      status: "rejected",
      runVersion: run.stateVersion,
      assignmentId: assignment.id,
      reason:
        "approved candidate rework requires failed dev-verification or staging-verification evidence",
    };
  }
  if (
    reopensApprovedCandidate &&
    (input.outcome.action !== "handoff" ||
      !isProductBuilderAgent(input.outcome.targetAgent ?? ""))
  ) {
    return {
      status: "rejected",
      runVersion: run.stateVersion,
      assignmentId: assignment.id,
      reason:
        "approved candidate rework must hand off to a builder so fixing has an active owner",
    };
  }
  const reopensRevision =
    suggested === "fixing" &&
    (run.phase === "aggregate-verification" ||
      run.phase === "reviewing" ||
      reopensApprovedCandidate);
  if (suggested === "ready-for-human-merge" && run.phase === "approved") {
    const mergedDevWorkstreams = await loadMergedDevPrWorkstreams(
      store,
      run.id,
      run.activeAttemptId,
      revisionMembers,
    );
    const requiredDevWorkstreams = workstreams.length > 0
      ? workstreams
      : revisionMembers.map((member) => member.memberKey);
    const devMergeComplete =
      requiredDevWorkstreams.length > 0 &&
      requiredDevWorkstreams.every((workstream) =>
        mergedDevWorkstreams.has(workstream)
      );
    if (!devMergeComplete) {
      return {
        status: "rejected",
        runVersion: run.stateVersion,
        assignmentId: assignment.id,
        reason:
          "ready-for-human-merge requires a merged dev PR for every current workstream and revision SHA",
      };
    }
  }

  const receipt = await store.recordOutcomeTransaction({
    outcome: input.outcome,
    toPhase: suggested,
    actorType: input.actorType ?? "agent",
    actorId: input.actorId,
    idempotencyKey: input.idempotencyKey,
    invalidateAttemptGates:
      reopensRevision && run.activeAttemptId
        ? { attemptId: run.activeAttemptId }
        : undefined,
    deactivateGitHubResourceRoles: reopensApprovedCandidate
      ? ["dev-pr"]
      : undefined,
  });

  return {
    ...receipt,
    notes: productPolicy.notes,
    skipReasons,
  };
}

/**
 * Open a fan-out of builder assignments (build + frontend) for full-stack work.
 * Records workstream keys and enqueues dispatch for each.
 */
export async function fanOutBuilders(
  config: ProductControllerConfig,
  input: {
    runId: string;
    parentAssignmentId: string;
    sourceAgent: string;
    objective: string;
    workstreams?: Array<{
      agent: "build" | "frontend";
      workstreamKey: string;
      objective?: string;
      mutationScope?: string[];
    }>;
    attemptId?: string | null;
    candidateRevisionDigest?: string | null;
    expectedRunVersion: number;
    idempotencyKey: string;
  },
): Promise<{ assignments: Assignment[]; receipt: TransitionReceipt }> {
  const store = config.store;
  const clock = config.clock ?? systemClock;
  const run = await store.getRun(input.runId);
  if (!run || run.kind !== "product") {
    return {
      assignments: [],
      receipt: {
        status: "rejected",
        runVersion: run?.stateVersion ?? 0,
        reason: "not a product run",
      },
    };
  }

  const streams = input.workstreams ?? [
    { agent: "build" as const, workstreamKey: "backend" },
    { agent: "frontend" as const, workstreamKey: "frontend" },
  ];

  // Advance parent via handoff to first builder; create siblings for the rest.
  const [first, ...rest] = streams;
  if (!first) {
    return {
      assignments: [],
      receipt: {
        status: "rejected",
        runVersion: run.stateVersion,
        reason: "no workstreams",
      },
    };
  }

  const firstId = crypto.randomUUID();
  const outcome: AgentOutcome = {
    assignmentId: input.parentAssignmentId,
    expectedRunVersion: input.expectedRunVersion,
    action: "handoff",
    status: "progress",
    targetAgent: first.agent,
    reason: `fan-out builders: ${streams.map((s) => s.agent).join(", ")}`,
    evidenceRefs: [],
    artifactRefs: [],
    blockers: [],
    checks: [],
    progressFingerprint: `fanout-${input.idempotencyKey}`,
    nextAssignment: {
      id: firstId,
      parentAssignmentId: input.parentAssignmentId,
      sourceSlackUserId: null,
      targetAgent: first.agent,
      objective: first.objective ?? `${input.objective} [${first.workstreamKey}]`,
      contextRefs: [`workstream:${first.workstreamKey}`, "fanout:true"],
      artifactRefs: [],
      acceptanceCriteria: run.acceptanceCriteria,
      mutationScope: first.mutationScope ?? ["worktree-code"],
      dependsOn: [],
      attempt: 1,
      attemptId: input.attemptId ?? run.activeAttemptId,
      candidateRevisionDigest: input.candidateRevisionDigest ?? null,
      deadlineAt: run.deadlineAt,
      idempotencyKey: `${input.idempotencyKey}:${first.workstreamKey}`,
    },
  };

  const parent = await store.getAssignment(input.parentAssignmentId);
  const receipt: TransitionReceipt = parent?.status === "completed"
    ? {
        status: "duplicate",
        runVersion: run.stateVersion,
        assignmentId: input.parentAssignmentId,
        reason: "fan-out parent already completed; repairing topology",
      }
    : await store.recordOutcomeTransaction({
        outcome,
        toPhase: "building",
        actorType: "agent",
        actorId: input.sourceAgent,
        idempotencyKey: input.idempotencyKey,
      });

  // Never spawn siblings when the parent handoff did not commit.
  if (
    receipt.status === "rejected" ||
    receipt.status === "escalated"
  ) {
    return { assignments: [], receipt };
  }

  const assignments: Assignment[] = [];
  const firstAsg =
    (await store.getAssignment(firstId)) ??
    (await store.listAssignments(run.id)).find(
      (assignment) =>
        assignment.idempotencyKey ===
          `${input.idempotencyKey}:${first.workstreamKey}`,
    );
  if (firstAsg) assignments.push(firstAsg);

  for (const stream of rest) {
    const asg = await store.createAssignment({
      id: crypto.randomUUID(),
      runId: run.id,
      parentAssignmentId: input.parentAssignmentId,
      sourceAgent: input.sourceAgent,
      sourceSlackUserId: null,
      targetAgent: stream.agent,
      objective:
        stream.objective ?? `${input.objective} [${stream.workstreamKey}]`,
      contextRefs: [`workstream:${stream.workstreamKey}`, "fanout:true"],
      artifactRefs: [],
      acceptanceCriteria: run.acceptanceCriteria,
      mutationScope: stream.mutationScope ?? ["worktree-code"],
      dependsOn: [],
      attempt: 1,
      attemptId: input.attemptId ?? run.activeAttemptId,
      candidateRevisionDigest: input.candidateRevisionDigest ?? null,
      deadlineAt: run.deadlineAt,
      idempotencyKey: `${input.idempotencyKey}:${stream.workstreamKey}`,
    });
    assignments.push(asg);
    await store.enqueueOutbox({
      id: crypto.randomUUID(),
      runId: run.id,
      assignmentId: asg.id,
      eventType: "assignment.dispatch",
      payload: {
        assignmentId: asg.id,
        targetAgent: stream.agent,
        workstreamKey: stream.workstreamKey,
      },
      idempotencyKey: `product-fanout-dispatch:${asg.idempotencyKey}`,
    });
  }

  const existingEvents = await store.listEvents(run.id);
  if (!existingEvents.some((event) =>
    event.idempotencyKey === `fanout-start:${input.idempotencyKey}`
  )) {
    await store.appendEvent({
      id: crypto.randomUUID(),
      runId: run.id,
      eventType: FANOUT_EVENT,
      actorType: "agent",
      actorId: input.sourceAgent,
      assignmentId: input.parentAssignmentId,
      outcomeId: null,
      fromPhase: run.phase,
      toPhase: "building",
      payloadVersion: 1,
      payload: {
        kind: "started",
        workstreams: streams.map((s) => s.workstreamKey),
        agents: streams.map((s) => s.agent),
      },
      idempotencyKey: `fanout-start:${input.idempotencyKey}`,
      occurredAt: clock.now(),
      observedAt: clock.now(),
    });
  }

  // Persist required workstreams for rejoin.
  if (!existingEvents.some((event) =>
    event.idempotencyKey === `product.workstreams.fanout:${input.idempotencyKey}`
  )) {
    await store.appendEvent({
      id: crypto.randomUUID(),
      runId: run.id,
      eventType: WORKSTREAM_EVENT,
      actorType: "agent",
      actorId: input.sourceAgent,
      assignmentId: input.parentAssignmentId,
      outcomeId: null,
      fromPhase: run.phase,
      toPhase: "building",
      payloadVersion: 1,
      payload: {
        workstreams: streams.map((s) => s.workstreamKey),
        fullStack: streams.length > 1,
      },
      idempotencyKey: `product.workstreams.fanout:${input.idempotencyKey}`,
      occurredAt: clock.now(),
      observedAt: clock.now(),
    });
  }

  return { assignments, receipt };
}

/**
 * Record a PR registration against the product run (multi-PR safe).
 * Same repo may hold multiple PRs distinguished by workstreamKey + number.
 */
export async function registerProductPr(
  config: ProductControllerConfig,
  input: {
    runId: string;
    assignmentId: string;
    owner: string;
    repo: string;
    number: number;
    role: "candidate" | "dev-pr" | "main-pr" | "dependency" | "review-target";
    workstreamKey: string;
    attemptId?: string | null;
    expectedHeadSha: string;
    actorId: string;
  },
): Promise<{ ok: true; key: string } | { ok: false; reason: string }> {
  const store = config.store;
  const clock = config.clock ?? systemClock;
  const run = await store.getRun(input.runId);
  if (!run || run.kind !== "product") {
    return { ok: false, reason: "not a product run" };
  }

  const key = prRegistrationKey(input);
  const now = clock.now();
  await store.appendEvent({
    id: crypto.randomUUID(),
    runId: run.id,
    eventType: "github.pr.registered",
    actorType: "agent",
    actorId: input.actorId,
    assignmentId: input.assignmentId,
    outcomeId: null,
    fromPhase: run.phase,
    toPhase: run.phase,
    payloadVersion: 1,
    payload: {
      owner: input.owner,
      repo: input.repo,
      number: input.number,
      role: input.role,
      workstreamKey: input.workstreamKey,
      attemptId: input.attemptId ?? run.activeAttemptId,
      expectedHeadSha: input.expectedHeadSha,
      registrationKey: key,
    },
    idempotencyKey: `pr-reg:${run.id}:${key}:${input.attemptId ?? run.activeAttemptId ?? "none"}:${input.expectedHeadSha}`,
    occurredAt: now,
    observedAt: now,
  });

  // Materialize association when resource already exists.
  const existing = await store.getGitHubResourceByCoords(
    input.owner,
    input.repo,
    input.number,
  );
  if (existing) {
    await store.registerPipelineGitHubResource({
      id: crypto.randomUUID(),
      runId: run.id,
      resourceId: existing.id,
      role: input.role,
      workstreamKey: input.workstreamKey,
      attemptId: input.attemptId ?? run.activeAttemptId,
      registeredByAssignmentId: input.assignmentId,
      expectedHeadSha: input.expectedHeadSha,
      active: true,
    });
  }

  return { ok: true, key };
}

/**
 * Bind review + checks + aggregate gates to one attempt revision vector.
 */
export async function ensureProductRevisionGates(
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
  const revisionMembers = await store.listRevisionMembers(input.attemptId);
  const attempt = await store.getAttempt(input.attemptId);
  const selectedMembers = input.memberKey
    ? revisionMembers.filter(
        (member) => member.memberKey === input.memberKey,
      )
    : revisionMembers;
  const targets = selectedMembers.length > 0
    ? selectedMembers
    : [
        {
          memberKey: input.memberKey ?? "candidate",
          headSha: input.subjectSha,
        },
      ];
  const gates: PipelineGate[] = [];
  for (const member of targets) {
    for (const gateKind of ["review", "checks"] as const) {
      const gate: PipelineGate = {
        id: `${input.attemptId}:${gateKind}:${member.memberKey}`,
        runId: input.runId,
        attemptId: input.attemptId,
        memberKey: member.memberKey,
        githubResourceId: null,
        gateKind,
        status: "pending",
        subjectSha: member.headSha,
        evidenceRef: null,
        provider: null,
        model: null,
        agentName: input.agentName ?? null,
        updatedAt: now,
      };
      await store.upsertGate(gate);
      gates.push(gate);
    }
  }
  const aggregate: PipelineGate = {
    id: `${input.attemptId}:aggregate:vector`,
    runId: input.runId,
    attemptId: input.attemptId,
    memberKey: null,
    githubResourceId: null,
    gateKind: "aggregate",
    status: "pending",
    subjectSha: attempt?.revisionDigest ?? input.subjectSha,
    evidenceRef: null,
    provider: null,
    model: null,
    agentName: input.agentName ?? null,
    updatedAt: now,
  };
  await store.upsertGate(aggregate);
  gates.push(aggregate);
  return gates;
}

/**
 * Apply a revision vector update; any member change invalidates aggregate gates.
 */
export async function updateProductRevision(
  config: ProductControllerConfig,
  input: {
    attemptId: string;
    members: AttemptRevisionMember[];
  },
): Promise<{ digest: string; invalidatedGateCount: number }> {
  return config.store.replaceAttemptRevision(input.attemptId, input.members);
}

export async function loadSkipReasons(
  store: PipelineStore,
  runId: string,
): Promise<SkipStageReason[]> {
  const events = await store.listEvents(runId);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.eventType === SKIP_EVENT) {
      const reasons = e.payload.reasons;
      if (Array.isArray(reasons)) {
        return reasons.filter(
          (r): r is SkipStageReason =>
            !!r &&
            typeof r === "object" &&
            (r as SkipStageReason).stage != null &&
            typeof (r as SkipStageReason).reason === "string",
        );
      }
    }
  }
  return [];
}

async function loadRegisteredPrKeys(
  store: PipelineStore,
  runId: string,
  attemptId: string | null,
  revisionShas: string[],
): Promise<string[]> {
  if (!attemptId || revisionShas.length === 0) return [];
  const acceptedRoles = new Set(["candidate", "main-pr", "review-target"]);
  const acceptedShas = new Set(revisionShas);
  const events = await store.listEvents(runId);
  const keys = new Set<string>();
  for (const e of events) {
    if (e.eventType !== "github.pr.registered") continue;
    if (
      e.payload.attemptId !== attemptId ||
      typeof e.payload.role !== "string" ||
      !acceptedRoles.has(e.payload.role) ||
      typeof e.payload.expectedHeadSha !== "string" ||
      !acceptedShas.has(e.payload.expectedHeadSha)
    ) {
      continue;
    }
    const key =
      typeof e.payload.registrationKey === "string"
        ? e.payload.registrationKey
        : null;
    if (key) {
      keys.add(key);
      continue;
    }
    const owner = e.payload.owner;
    const repo = e.payload.repo;
    const number = e.payload.number;
    const role = e.payload.role;
    const workstreamKey = e.payload.workstreamKey;
    if (
      typeof owner === "string" &&
      typeof repo === "string" &&
      typeof number === "number" &&
      typeof role === "string" &&
      typeof workstreamKey === "string"
    ) {
      keys.add(
        prRegistrationKey({ owner, repo, number, role, workstreamKey }),
      );
    }
  }
  // Also surface association rows when present.
  if (store.listPipelineGitHubResources) {
    const assocs = await store.listPipelineGitHubResources(runId, true);
    for (const a of assocs) {
      if (
        a.attemptId !== attemptId ||
        !acceptedRoles.has(a.role) ||
        !a.expectedHeadSha ||
        !acceptedShas.has(a.expectedHeadSha)
      ) {
        continue;
      }
      keys.add(`${a.role}:${a.workstreamKey}`);
    }
  }
  return [...keys];
}

function isDevVerificationRegression(outcome: AgentOutcome): boolean {
  const failedCheck = outcome.checks.find(
    (check) =>
      (check.name === "dev-verification" ||
        check.name === "staging-verification") &&
      check.status === "failed",
  );
  if (failedCheck?.evidenceRef?.trim()) return true;
  return outcome.evidenceRefs.some(
    (ref) => {
      const [prefix, suffix] = ref.split(":", 2);
      return (
        (prefix === "dev-verification" || prefix === "staging-verification") &&
        Boolean(suffix?.trim())
      );
    },
  );
}

async function loadMergedDevPrWorkstreams(
  store: PipelineStore,
  runId: string,
  attemptId: string | null,
  revisionMembers: AttemptRevisionMember[],
): Promise<Set<string>> {
  if (!attemptId || revisionMembers.length === 0) return new Set();
  const candidates: Array<{
    workstreamKey: string;
    expectedHeadSha: string;
    mergedHeadSha: string;
  }> = [];
  const associations = await store.listPipelineGitHubResources(runId, true);
  for (const association of associations) {
    if (
      association.role !== "dev-pr" ||
      association.attemptId !== attemptId ||
      !association.expectedHeadSha
    ) {
      continue;
    }
    const resource = await store.getGitHubResource(association.resourceId);
    if (
      resource?.snapshot?.state === "MERGED" &&
      resource.snapshot.headRefOid === association.expectedHeadSha
    ) {
      candidates.push({
        workstreamKey: association.workstreamKey,
        expectedHeadSha: association.expectedHeadSha,
        mergedHeadSha: resource.snapshot.headRefOid,
      });
    }
  }
  return mergedDevPrCoverage(revisionMembers, candidates);
}

export function mergedDevPrCoverage(
  revisionMembers: AttemptRevisionMember[],
  candidates: Array<{
    workstreamKey: string;
    expectedHeadSha: string;
    mergedHeadSha: string;
  }>,
): Set<string> {
  const requiredShaByWorkstream = new Map(
    revisionMembers.map((member) => [member.memberKey, member.headSha]),
  );
  const covered = new Set<string>();
  for (const candidate of candidates) {
    const requiredSha = requiredShaByWorkstream.get(candidate.workstreamKey);
    if (
      requiredSha &&
      candidate.expectedHeadSha === requiredSha &&
      candidate.mergedHeadSha === requiredSha
    ) {
      covered.add(candidate.workstreamKey);
    }
  }
  return covered;
}

async function loadReviewFingerprints(
  store: PipelineStore,
  runId: string,
): Promise<string[]> {
  const events = await store.listEvents(runId);
  const fps: string[] = [];
  for (const e of events) {
    if (e.eventType !== REVIEW_FINDINGS_EVENT) continue;
    const fp = e.payload.fingerprint;
    if (typeof fp === "string") fps.push(fp);
  }
  return fps;
}

async function loadWorkstreams(
  store: PipelineStore,
  runId: string,
): Promise<string[]> {
  const events = await store.listEvents(runId);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.eventType === WORKSTREAM_EVENT) {
      const list = e.payload.workstreams;
      if (Array.isArray(list)) {
        return list.filter((w): w is string => typeof w === "string");
      }
    }
  }
  return [];
}

function inferReviewVerdict(
  outcome: AgentOutcome,
  phase: ProductPhase,
): "approved" | "changes_requested" | "comment" | null {
  if (phase !== "reviewing") return null;
  const reviewCheck = outcome.checks.find(
    (c) => c.name === "review" || c.name === "verdict",
  );
  if (reviewCheck?.status === "passed") return "approved";
  if (reviewCheck?.status === "failed") return "changes_requested";
  if (outcome.status === "succeeded") return "approved";
  if (outcome.status === "failed") return "changes_requested";
  return null;
}

/**
 * Build injection block for dispatch when assignment is under an active product run.
 */
export async function productContextForAssignment(
  config: ProductControllerConfig,
  run: ProductRun,
  assignment: Assignment,
): Promise<string> {
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
  const skipReasons = await loadSkipReasons(config.store, run.id);
  const registeredPrKeys = await loadRegisteredPrKeys(
    config.store,
    run.id,
    attemptId,
    revisionMembers.map((member) => member.headSha),
  );
  const workstreams = await loadWorkstreams(config.store, run.id);
  return buildProductContext({
    run,
    assignment,
    artifactDir: defaultProductArtifactDir(root, run.id),
    revisionMembers,
    revisionDigest,
    skipReasons,
    requiredWorkstreams: workstreams,
    registeredPrKeys,
    gates,
  });
}

/**
 * Soft gate: may we create a ProductRun for this explicit start?
 */
export function shouldCreateProductRun(flags: {
  productPipelineEnabled: boolean;
  runtimeMode: "off" | "shadow" | "active";
  /** Explicit !pm or !build only for MVP. */
  explicitStart: boolean;
}): boolean {
  if (!flags.productPipelineEnabled) return false;
  if (flags.runtimeMode !== "active") return false;
  return flags.explicitStart;
}
