import type { PipelineStore } from "./store/interface.ts";
import type { Clock } from "../time/clock.ts";
import { systemClock } from "../time/clock.ts";
import { reclaimExpiredLeases } from "./outbox.ts";
import { reclaimDevServerJobs } from "./dev-server-jobs.ts";
import type {
  PipelineSessionReader,
  SlackAuditCallback,
} from "./dispatch.ts";

export type RecoveryReport = {
  reclaimedOutboxLeases: number;
  reclaimedDevServerLeases: number;
  deadlineReleasedDevServerJobs: number;
  reclaimedGitHubLeases: number;
};

/**
 * Startup/wake recovery for the pipeline substrate.
 *
 * Reclaims expired outbox, dev-server, and GitHub leases so work can resume
 * after process death without stealing live leases.
 *
 * Dead runner processes are handled separately by
 * `checkOrphanedSessions` in `src/lifecycle/health.ts`, which marks them
 * `interrupted` (session lastError + agent status failed) rather than silently
 * idle. Model-session resume remains an optimization; assignment/run/artifact
 * state is always re-injected on dispatch.
 */
export async function recoverPipelineRuntime(
  store: PipelineStore,
  clock: Clock = systemClock,
): Promise<RecoveryReport> {
  const reclaimedOutboxLeases = await reclaimExpiredLeases(store, clock);

  let reclaimedDevServerLeases = 0;
  let deadlineReleasedDevServerJobs = 0;
  try {
    const dev = await reclaimDevServerJobs(store, clock);
    reclaimedDevServerLeases = dev.leasesReclaimed;
    deadlineReleasedDevServerJobs = dev.deadlineReleased;
  } catch {
    // Store may predate Phase 6 methods in mixed test fixtures.
  }

  let reclaimedGitHubLeases = 0;
  try {
    reclaimedGitHubLeases = await store.reclaimExpiredGitHubResourceLeases(
      clock.now(),
    );
  } catch {
    // Store may predate Phase 5 methods in mixed test fixtures.
  }

  return {
    reclaimedOutboxLeases,
    reclaimedDevServerLeases,
    deadlineReleasedDevServerJobs,
    reclaimedGitHubLeases,
  };
}

export type AssignmentRecoveryReport = {
  resumesEnqueued: number;
  escalationsRecorded: number;
};

/**
 * Reconcile the second half of at-least-once delivery: an outbox row may be
 * delivered while its runner dies before recording an outcome. Re-wake idle
 * owners with deterministic keys, then durably escalate after two attempts.
 */
export async function reconcileStalePipelineAssignments(input: {
  store: PipelineStore;
  sessionReader: PipelineSessionReader;
  audit?: SlackAuditCallback;
  now?: number;
  staleMs?: number;
  maxRetries?: number;
}): Promise<AssignmentRecoveryReport> {
  const sessions = await input.sessionReader.getAll?.();
  if (!sessions) return { resumesEnqueued: 0, escalationsRecorded: 0 };
  const now = input.now ?? Date.now();
  const staleMs = input.staleMs ?? 5 * 60_000;
  const maxRetries = input.maxRetries ?? 2;
  let resumesEnqueued = 0;
  let escalationsRecorded = 0;

  for (const session of sessions.values()) {
    if (!session.activePipelineRunId) continue;
    const run = await input.store.getRun(session.activePipelineRunId);
    if (!run || run.status !== "active") continue;
    const [assignments, outbox] = await Promise.all([
      input.store.listAssignments(run.id),
      input.store.listOutbox(run.id),
    ]);

    for (const assignment of assignments) {
      if (assignment.status !== "pending" && assignment.status !== "leased") {
        continue;
      }
      const ownerBusy = assignment.targetAgent === "lead" ||
          assignment.targetAgent === "default" || assignment.targetAgent === "junior"
        ? session.status === "busy" || session.status === "draining"
        : session.agentSessions?.[assignment.targetAgent]?.status === "busy";
      if (ownerBusy) continue;
      const activeInvocation =
        assignment.targetAgent === "lead" ||
          assignment.targetAgent === "default" || assignment.targetAgent === "junior"
          ? session.activePipelineInvocation
          : session.agentSessions?.[assignment.targetAgent]
            ?.activePipelineInvocation;
      const outcomeBaseline =
        activeInvocation?.assignmentId === assignment.id
          ? activeInvocation.outcomeCountAtDispatch
          : 0;
      if (
        (await input.store.listOutcomes(assignment.id)).length > outcomeBaseline
      ) continue;

      const wakes = outbox
        .filter((item) =>
          item.assignmentId === assignment.id &&
          ["assignment.dispatch", "assignment.continue", "assignment.resume"].includes(item.eventType)
        )
        .sort((a, b) => b.createdAt - a.createdAt);
      const lastWake = wakes[0];
      if (!lastWake || lastWake.status !== "delivered") continue;
      const lastWakeAt = lastWake.deliveredAt ?? lastWake.createdAt;
      if (now - lastWakeAt < staleMs) continue;
      const outboxRecoveryAttempts = wakes.filter((item) =>
        item.idempotencyKey.startsWith(`pipeline-recovery:${assignment.id}:`)
      ).length;
      const recoveryAttempts = Math.max(
        outboxRecoveryAttempts,
        activeInvocation?.retryCount ?? 0,
      );

      if (recoveryAttempts < maxRetries) {
        const attempt = recoveryAttempts + 1;
        await input.store.enqueueOutbox({
          id: crypto.randomUUID(),
          runId: run.id,
          assignmentId: assignment.id,
          eventType: "assignment.resume",
          payload: {
            assignmentId: assignment.id,
            targetAgent: assignment.targetAgent,
            recoveryAttempt: attempt,
            recoveryReason: "delivered assignment has no durable outcome",
          },
          idempotencyKey: `pipeline-recovery:${assignment.id}:${attempt}`,
        });
        resumesEnqueued += 1;
        continue;
      }

      const currentRun = await input.store.getRun(run.id);
      if (!currentRun || currentRun.status === "terminal") continue;
      const receipt = await input.store.recordOutcomeTransaction({
        outcome: {
          assignmentId: assignment.id,
          expectedRunVersion: currentRun.stateVersion,
          action: "escalate",
          status: "blocked",
          reason: `Assignment remained without a typed outcome after ${maxRetries} recovery wakes.`,
          evidenceRefs: [],
          artifactRefs: [],
          blockers: [{
            kind: "infra_failure",
            detail: "runner was no longer active after a delivered dispatch",
          }],
          checks: [],
          progressFingerprint: `stale-settlement:${assignment.id}`,
        },
        toPhase: "needs-human",
        actorType: "system",
        actorId: "pipeline-recovery",
        idempotencyKey: `pipeline-recovery-exhausted:${assignment.id}`,
      });
      if (receipt.status !== "rejected") {
        escalationsRecorded += 1;
        try {
          await input.audit?.({
            channelId: run.channelId,
            threadId: run.threadId,
            text: `:warning: Pipeline assignment \`${assignment.id.slice(0, 8)}\` stopped without reporting an outcome after ${maxRetries} recovery wakes and needs human attention.`,
          });
        } catch {
          // The durable escalation is authoritative; Slack audit is best-effort.
        }
        break;
      }
    }
  }
  return { resumesEnqueued, escalationsRecorded };
}
