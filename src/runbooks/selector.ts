import { bindInputs, type BoundInputs } from "./binder.ts";
import { createRunEvidence, buildProcedureFallback, type RunbookRunEvidence, type ProcedureFallback } from "./evidence.ts";
import { matchRunbookDetailed, type MatchOptions } from "./matcher.ts";
import type { RunbookDefinition } from "./types.ts";

export type SelectionResult =
  | {
      selected: true;
      runbook: RunbookDefinition;
      confidence: number;
      matchedExample: string;
      boundInputs: BoundInputs;
      evidence: RunbookRunEvidence;
    }
  | {
      selected: false;
      reason:
        | "no-match"
        | "ambiguous"
        | "excluded"
        | "below-threshold"
        | "risk-ceiling";
      candidates?: Array<{ name: string; confidence: number }>;
      procedureFallback: ProcedureFallback;
    };

export function selectRunbook(
  request: string,
  context: Record<string, string>,
  options?: MatchOptions,
): SelectionResult {
  const { result, reason, candidates } = matchRunbookDetailed(
    request,
    options,
  );

  if (!result) {
    return {
      selected: false,
      reason: reason ?? "no-match",
      candidates,
      procedureFallback: buildProcedureFallback(request),
    };
  }

  const bound = bindInputs(result.runbook, context);
  const evidence = createRunEvidence(
    result.runbook,
    bound.bound,
    request,
    Date.now(),
  );

  return {
    selected: true,
    runbook: result.runbook,
    confidence: result.confidence,
    matchedExample: result.matchedExample,
    boundInputs: bound,
    evidence,
  };
}
