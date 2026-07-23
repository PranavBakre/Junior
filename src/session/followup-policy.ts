/**
 * Pure eligibility policy for short follow-up interruption.
 * Stateless — all inputs are explicit; no side effects.
 */

export type BusyFollowupDecision = {
  action: "buffer" | "interrupt";
  reason: string;
};

export type BusyFollowupContext = {
  /** Feature flag state. */
  enabled: boolean;
  /** Slack user ID of the new message sender. */
  senderUserId: string;
  /** Slack user ID of the human who started the active busy turn. Null = unknown. */
  activeTurnAuthor: string | null;
  /** Character length of the follow-up message text. */
  messageLength: number;
  /** Maximum allowed character length for a "short" follow-up. */
  maxMessageLength: number;
  /** Whether the active runner has reported tool-use events (possible mutations). */
  activeTurnHasSideEffects: boolean;
  /** Whether the current turn was already interrupt-consolidated once. */
  activeTurnAlreadyInterrupted: boolean;
  /** Whether the sender is a real human (not a bot or system). */
  isSenderHuman: boolean;
};

export function evaluateBusyFollowup(ctx: BusyFollowupContext): BusyFollowupDecision {
  if (!ctx.enabled) {
    return { action: "buffer", reason: "feature-disabled" };
  }
  if (!ctx.isSenderHuman) {
    return { action: "buffer", reason: "sender-is-bot" };
  }
  if (!ctx.activeTurnAuthor) {
    return { action: "buffer", reason: "no-active-turn-author" };
  }
  if (ctx.senderUserId !== ctx.activeTurnAuthor) {
    return { action: "buffer", reason: "different-author" };
  }
  if (ctx.messageLength > ctx.maxMessageLength) {
    return { action: "buffer", reason: "message-too-long" };
  }
  if (ctx.activeTurnHasSideEffects) {
    return { action: "buffer", reason: "side-effects-started" };
  }
  if (ctx.activeTurnAlreadyInterrupted) {
    return { action: "buffer", reason: "already-interrupted" };
  }
  return { action: "interrupt", reason: "eligible-short-followup" };
}
