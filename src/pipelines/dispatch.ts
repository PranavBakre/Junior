/**
 * Internal assignment dispatch — wakes a target agent without using Slack
 * as the execution bus. Slack audit posts are optional and best-effort.
 */

import type { SlackMessageEvent } from "../slack/events.ts";
import type { PipelineInvocationRef, ThreadSession } from "../session/types.ts";
import type { Assignment, PipelineRun } from "./types.ts";
import {
  buildAssignmentContext,
  composeDispatchPrompt,
} from "./context.ts";
import { composeBugDispatchPrompt } from "./bug/context.ts";
import { composeProductDispatchPrompt } from "./product/context.ts";
import { log } from "../logger.ts";

/** Minimal session manager surface used for pipeline dispatch. */
export type PipelineSessionDispatcher = {
  handleAgentMessage: (
    event: SlackMessageEvent,
    agentName: string,
  ) => Promise<void>;
};

/** Optional session store for busy detection before dispatch. */
export type PipelineSessionReader = {
  get: (threadId: string) => Promise<ThreadSession | undefined>;
  getAll?: () => Promise<Map<string, ThreadSession>>;
};

export type SlackAuditCallback = (args: {
  channelId: string;
  threadId: string;
  text: string;
}) => Promise<void>;

export type DispatchAssignmentInput = {
  run: PipelineRun;
  assignment: Assignment;
  /** Optional free-text prompt body (defaults to assignment.objective). */
  prompt?: string;
  /** Synthetic user id recorded on the internal event. */
  userId?: string;
  /** Shared idempotency / dedupe key for the synthetic Slack event. */
  dedupeKey?: string;
  pipelineInvocation?: PipelineInvocationRef;
};

export type DispatchAssignmentResult = {
  status: "dispatched" | "buffered" | "rejected";
  reason?: string;
  targetAgent: string;
  assignmentId: string;
};

export type DispatchDeps = {
  dispatcher: PipelineSessionDispatcher;
  sessionReader?: PipelineSessionReader;
  audit?: SlackAuditCallback;
  /**
   * When true, always call handleAgentMessage even if busy (SessionManager
   * buffers). Default true — durable buffer is preferred over drop.
   */
  alwaysEnqueue?: boolean;
  /**
   * Optional pre-built <bug-context> block for bug-run assignments
   * (reproducer/build/review). Injected ahead of pipeline-assignment.
   */
  bugContext?: string;
  /** Pre-built <product-context> block for product-run assignments. */
  productContext?: string;
};

/**
 * Dispatch an assignment to its target agent via SessionManager.
 * If the target is already busy, SessionManager buffers the message; we
 * surface that as `buffered` when we can observe session state.
 */
export async function dispatchAssignment(
  deps: DispatchDeps,
  input: DispatchAssignmentInput,
): Promise<DispatchAssignmentResult> {
  const { run, assignment } = input;
  const targetAgent = assignment.targetAgent.trim();
  if (!targetAgent) {
    return {
      status: "rejected",
      reason: "assignment has empty targetAgent",
      targetAgent: "",
      assignmentId: assignment.id,
    };
  }

  if (targetAgent === "human") {
    // Human escalations are not agent dispatches — audit only.
    await safeAudit(deps.audit, {
      channelId: run.channelId,
      threadId: run.threadId,
      text: `:raising_hand: *Pipeline escalate* assignment \`${assignment.id.slice(0, 8)}\` needs human: ${assignment.objective}`,
    });
    return {
      status: "dispatched",
      reason: "human escalation recorded (no agent wake)",
      targetAgent,
      assignmentId: assignment.id,
    };
  }

  let busy = false;
  if (deps.sessionReader) {
    try {
      const session = await deps.sessionReader.get(run.threadId);
      busy = isTargetBusy(session, targetAgent);
    } catch (err) {
      log.warn(
        "pipeline-dispatch",
        `session read failed for ${run.threadId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const contextBlock = buildAssignmentContext({ run, assignment });
  const shouldInjectBugContext =
    run.kind === "bug" &&
    isBugWorkerAgent(assignment.targetAgent) &&
    Boolean(deps.bugContext);
  const prompt = shouldInjectBugContext
    ? composeBugDispatchPrompt({
        bugContext: deps.bugContext!,
        assignmentContext: contextBlock,
        objective: input.prompt ?? assignment.objective,
      })
    : run.kind === "product" && deps.productContext
      ? composeProductDispatchPrompt({
          productContext: deps.productContext,
          assignmentContext: contextBlock,
          objective: input.prompt ?? assignment.objective,
        })
      : composeDispatchPrompt(
          contextBlock,
          input.prompt ?? assignment.objective,
        );
  const dedupeKey =
    input.dedupeKey ??
    `pipeline:${run.id}:${assignment.id}:${assignment.idempotencyKey}`;

  const event: SlackMessageEvent = {
    threadId: run.threadId,
    channel: run.channelId,
    user: input.userId ?? "pipeline-internal",
    text: prompt,
    ts: run.threadId,
    command: null,
    isSelfBot: true,
    botUsername: "pipeline",
    dedupeKey,
    pipelineInvocation: input.pipelineInvocation,
  };

  const alwaysEnqueue = deps.alwaysEnqueue !== false;
  if (busy && !alwaysEnqueue) {
    return {
      status: "buffered",
      reason: "target agent is busy; assignment left pending in outbox",
      targetAgent,
      assignmentId: assignment.id,
    };
  }

  try {
    await deps.dispatcher.handleAgentMessage(event, targetAgent);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(
      "pipeline-dispatch",
      `dispatch failed run=${run.id} assignment=${assignment.id} target=${targetAgent}: ${message}`,
    );
    return {
      status: "rejected",
      reason: `dispatch error: ${message}`,
      targetAgent,
      assignmentId: assignment.id,
    };
  }

  // Slack audit is best-effort — failure must not lose the handoff.
  await safeAudit(deps.audit, {
    channelId: run.channelId,
    threadId: run.threadId,
    text: busy
      ? `:hourglass_flowing_sand: *Pipeline handoff buffered* \`${assignment.sourceAgent}\` → \`${targetAgent}\` (\`${assignment.id.slice(0, 8)}\`)`
      : `:arrow_right: *Pipeline handoff* \`${assignment.sourceAgent}\` → \`${targetAgent}\` (\`${assignment.id.slice(0, 8)}\`)`,
  });

  return {
    status: busy ? "buffered" : "dispatched",
    reason: busy ? "target busy; message buffered by session manager" : undefined,
    targetAgent,
    assignmentId: assignment.id,
  };
}

function isTargetBusy(
  session: ThreadSession | undefined,
  targetAgent: string,
): boolean {
  if (!session) return false;
  if (targetAgent === "lead" || targetAgent === "default" || targetAgent === "junior") {
    return session.status === "busy";
  }
  const agent = session.agentSessions?.[targetAgent];
  return agent?.status === "busy";
}

async function safeAudit(
  audit: SlackAuditCallback | undefined,
  args: { channelId: string; threadId: string; text: string },
): Promise<void> {
  if (!audit) return;
  try {
    await audit(args);
  } catch (err) {
    log.warn(
      "pipeline-dispatch",
      `Slack audit post failed (handoff not lost): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function isBugWorkerAgent(agent: string): boolean {
  return (
    agent === "reproducer" ||
    agent === "build" ||
    agent === "frontend" ||
    agent === "review"
  );
}
