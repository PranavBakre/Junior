/**
 * Pure eligibility policy for short follow-up interruption.
 * Stateless — all inputs are explicit; no side effects.
 */

export type BusyFollowupDecision = {
  action: "buffer" | "interrupt";
  reason: string;
};

export type FollowupMessageContext = {
  text: string;
  hasFiles: boolean;
  hasCommand: boolean;
  hasPipelineMetadata: boolean;
  isInternal: boolean;
};

export type BusyFollowupContext = {
  enabled: boolean;
  senderUserId: string | null;
  activeTurnAuthor: string | null;
  activeMessage: FollowupMessageContext | null;
  incomingMessage: FollowupMessageContext;
  maxMessageLength: number;
  maxWordCount: number;
  elapsedMs: number;
  maxElapsedMs: number;
  activeTurnHasSideEffects: boolean;
  activeTurnAlreadyInterrupted: boolean;
  sameAgentSlot: boolean;
  ownsExactHandle: boolean;
  providerSupportsInterruption: boolean;
};

function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function isMultilineOrCodeHeavy(text: string): boolean {
  return (
    /[\r\n]/.test(text) ||
    text.includes("```") ||
    /(?:^|\s)(?:`[^`]+`|\{[^}]+\}|<[^>]+>)(?:\s|$)/.test(text)
  );
}

function messageIneligibleReason(
  message: FollowupMessageContext,
  label: "active" | "incoming",
  maxMessageLength: number,
  maxWordCount: number,
): string | null {
  if (message.hasFiles) return `${label}-has-files`;
  if (message.hasCommand) return `${label}-has-command`;
  if (message.hasPipelineMetadata) return `${label}-has-pipeline-metadata`;
  if (message.isInternal) return `${label}-is-internal`;
  if (message.text.length > maxMessageLength) return `${label}-too-long`;
  if (wordCount(message.text) > maxWordCount) return `${label}-too-many-words`;
  if (isMultilineOrCodeHeavy(message.text)) return `${label}-multiline-or-code`;
  return null;
}

export function evaluateBusyFollowup(ctx: BusyFollowupContext): BusyFollowupDecision {
  if (!ctx.enabled) return { action: "buffer", reason: "feature-disabled" };
  if (!ctx.senderUserId) return { action: "buffer", reason: "sender-is-not-human" };
  if (!ctx.activeTurnAuthor) {
    return { action: "buffer", reason: "no-active-turn-author" };
  }
  if (ctx.senderUserId !== ctx.activeTurnAuthor) {
    return { action: "buffer", reason: "different-author" };
  }
  if (!ctx.sameAgentSlot) return { action: "buffer", reason: "different-agent-slot" };
  if (!ctx.ownsExactHandle) return { action: "buffer", reason: "handle-not-owned" };
  if (!ctx.providerSupportsInterruption) {
    return { action: "buffer", reason: "provider-not-supported" };
  }
  if (!ctx.activeMessage) return { action: "buffer", reason: "no-active-message" };
  if (ctx.elapsedMs < 0 || ctx.elapsedMs > ctx.maxElapsedMs) {
    return { action: "buffer", reason: "outside-time-window" };
  }
  if (ctx.activeTurnHasSideEffects) {
    return { action: "buffer", reason: "side-effects-started" };
  }
  if (ctx.activeTurnAlreadyInterrupted) {
    return { action: "buffer", reason: "already-interrupted" };
  }

  const activeReason = messageIneligibleReason(
    ctx.activeMessage,
    "active",
    ctx.maxMessageLength,
    ctx.maxWordCount,
  );
  if (activeReason) return { action: "buffer", reason: activeReason };
  const incomingReason = messageIneligibleReason(
    ctx.incomingMessage,
    "incoming",
    ctx.maxMessageLength,
    ctx.maxWordCount,
  );
  if (incomingReason) return { action: "buffer", reason: incomingReason };

  return { action: "interrupt", reason: "eligible-short-followup" };
}
