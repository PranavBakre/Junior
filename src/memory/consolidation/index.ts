// Consolidation engine — offline write path (memory v3 §7). Barrel.

export {
  consolidateSession,
  cosine,
  DEFAULT_DEDUP_THRESHOLD,
  type ConsolidateSessionArgs,
} from "./consolidate.ts";
export { buildConsolidationPrompt } from "./prompt.ts";
export {
  runConsolidationSweep,
  summarizeConsolidationSweep,
  DEFAULT_BODY_CAP,
  DEFAULT_MAX_BATCH_CHARS,
  type ConsolidateV3Entry,
  type RunConsolidationSweepArgs,
} from "./sweep.ts";
export {
  consolidationOutputSchema,
  type ClaimContextSample,
  type ClaimDraft,
  type ConsolidationContext,
  type ConsolidationInvoke,
  type ConsolidationOutput,
  type ConsolidationReport,
  type EpisodeDraft,
  type ProfileDraft,
} from "./types.ts";
