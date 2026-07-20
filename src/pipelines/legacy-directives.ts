/**
 * Convert legacy `!review` / `!reproducer` / other pure agent directives into
 * structured pipeline handoffs when PIPELINE_RUNTIME_MODE=active and the
 * thread already has an active pipeline run.
 *
 * Uses a shared idempotency key so Slack, pure-response, and MCP copies cannot
 * dispatch twice. Does nothing when mode is off/shadow.
 */

import type { AgentDirective } from "../support/directives.ts";
import { canDispatch } from "../support/agents.ts";
import type { OrchestratorContext } from "../agents/registry.ts";
import { log } from "../logger.ts";
import type { PipelineStore } from "./store/interface.ts";
import type { TransitionReceipt } from "./types.ts";
import { requestHandoff, type OutcomeAuthContext } from "./outcomes.ts";

export type LegacyDirectiveConversionInput = {
  directives: AgentDirective[];
  /** Message ts used in shared idempotency keys. */
  messageTs: string;
  sourceAgent: string;
  runId: string;
  /** Current open assignment id for the source agent (if known). */
  sourceAssignmentId: string;
  expectedRunVersion: number;
  auth: OutcomeAuthContext;
  orchestratorContext?: OrchestratorContext;
};

export type LegacyDirectiveConversionResult = {
  converted: Array<{
    agentName: string;
    receipt: TransitionReceipt;
    idempotencyKey: string;
  }>;
  skipped: Array<{ agentName: string; reason: string }>;
};

/**
 * Shared idempotency key for a legacy directive conversion so Slack posts,
 * pure-response interception, and MCP agent_dispatch cannot double-dispatch.
 */
export function legacyDirectiveIdempotencyKey(args: {
  runId: string;
  messageTs: string;
  sourceAgent: string;
  targetAgent: string;
  index: number;
}): string {
  return `legacy-directive:${args.runId}:${args.messageTs}:${args.sourceAgent}:${args.targetAgent}:${args.index}`;
}

/**
 * Convert directives into typed handoff outcomes. Caller must only invoke when
 * PIPELINE_RUNTIME_MODE=active and the thread has an active pipeline run.
 */
export async function convertLegacyDirectivesToHandoffs(
  store: PipelineStore,
  input: LegacyDirectiveConversionInput,
  opts: { githubTrackingEnabled?: boolean } = {},
): Promise<LegacyDirectiveConversionResult> {
  const converted: LegacyDirectiveConversionResult["converted"] = [];
  const skipped: LegacyDirectiveConversionResult["skipped"] = [];
  const ctx = input.orchestratorContext ?? "default";

  for (const [index, directive] of input.directives.entries()) {
    if (!canDispatch(input.sourceAgent, directive.agentName, ctx)) {
      skipped.push({
        agentName: directive.agentName,
        reason: `unauthorized edge ${input.sourceAgent}→${directive.agentName}`,
      });
      continue;
    }

    const idempotencyKey = legacyDirectiveIdempotencyKey({
      runId: input.runId,
      messageTs: input.messageTs,
      sourceAgent: input.sourceAgent,
      targetAgent: directive.agentName,
      index,
    });
    const nextIdempotencyKey = `${idempotencyKey}:assignment`;

    log.info(
      "pipeline-legacy",
      `converting !${directive.agentName} → handoff run=${input.runId} key=${idempotencyKey}`,
    );

    const receipt = await requestHandoff(
      { store, githubTrackingEnabled: opts.githubTrackingEnabled },
      {
        assignmentId: input.sourceAssignmentId,
        expectedRunVersion: input.expectedRunVersion,
        targetAgent: directive.agentName,
        objective: directive.prompt || `Legacy directive !${directive.agentName}`,
        reason: `legacy directive !${directive.agentName}`,
        progressFingerprint: `legacy:${directive.agentName}:${input.messageTs}`,
        idempotencyKey,
        nextIdempotencyKey,
        auth: input.auth,
      },
    );

    converted.push({
      agentName: directive.agentName,
      receipt,
      idempotencyKey,
    });
  }

  return { converted, skipped };
}
