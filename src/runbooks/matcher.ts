import { listRunbooks } from "./registry.ts";
import { RUNBOOK_RISKS, type RunbookDefinition, type RunbookRisk } from "./types.ts";

export interface MatchResult {
  runbook: RunbookDefinition;
  confidence: number;
  matchedExample: string;
}

export interface MatchOptions {
  ownerAgent?: string;
  riskCeiling?: RunbookRisk;
  minConfidence?: number;
}

const DEFAULT_MIN_CONFIDENCE = 0.6;
const AMBIGUITY_GAP = 0.15;

export function matchRunbook(
  request: string,
  options?: MatchOptions,
): MatchResult | null {
  const minConfidence = options?.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const riskCeiling = options?.riskCeiling;
  const riskCeilingIdx = riskCeiling ? RUNBOOK_RISKS.indexOf(riskCeiling) : -1;

  const candidates = listRunbooks().filter((rb) => {
    if (options?.ownerAgent && rb.ownerAgent !== options.ownerAgent) return false;
    if (riskCeiling && riskCeilingIdx >= 0) {
      const rbIdx = RUNBOOK_RISKS.indexOf(rb.risk);
      if (rbIdx > riskCeilingIdx) return false;
    }
    return true;
  });

  if (candidates.length === 0) return null;

  const reqTokens = tokenize(request);
  const scored: Array<MatchResult & { excluded: boolean }> = [];

  for (const rb of candidates) {
    let bestScore = 0;
    let bestExample = "";

    for (const example of rb.intent.examples) {
      const score = jaccardSimilarity(reqTokens, tokenize(example));
      if (score > bestScore) {
        bestScore = score;
        bestExample = example;
      }
    }

    let excluded = false;
    for (const exclude of rb.intent.excludes) {
      const excScore = jaccardSimilarity(reqTokens, tokenize(exclude));
      if (excScore > bestScore) {
        excluded = true;
        break;
      }
    }

    scored.push({
      runbook: rb,
      confidence: bestScore,
      matchedExample: bestExample,
      excluded,
    });
  }

  scored.sort((a, b) => b.confidence - a.confidence);

  const best = scored[0];
  if (!best || best.confidence < minConfidence) return null;
  if (best.excluded) return null;

  if (scored.length > 1) {
    const second = scored[1];
    if (best.confidence - second.confidence < AMBIGUITY_GAP) return null;
  }

  return {
    runbook: best.runbook,
    confidence: best.confidence,
    matchedExample: best.matchedExample,
  };
}

export function matchRunbookDetailed(
  request: string,
  options?: MatchOptions,
): {
  result: MatchResult | null;
  reason?: "no-match" | "ambiguous" | "excluded" | "below-threshold" | "risk-ceiling";
  candidates?: Array<{ name: string; confidence: number }>;
} {
  const minConfidence = options?.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const riskCeiling = options?.riskCeiling;
  const riskCeilingIdx = riskCeiling ? RUNBOOK_RISKS.indexOf(riskCeiling) : -1;

  const allRunbooks = listRunbooks();
  const candidates = allRunbooks.filter((rb) => {
    if (options?.ownerAgent && rb.ownerAgent !== options.ownerAgent) return false;
    if (riskCeiling && riskCeilingIdx >= 0) {
      const rbIdx = RUNBOOK_RISKS.indexOf(rb.risk);
      if (rbIdx > riskCeilingIdx) return false;
    }
    return true;
  });

  if (candidates.length === 0) {
    if (allRunbooks.length > 0 && riskCeiling) {
      return { result: null, reason: "risk-ceiling" };
    }
    return { result: null, reason: "no-match" };
  }

  const reqTokens = tokenize(request);
  const scored: Array<{
    name: string;
    runbook: RunbookDefinition;
    confidence: number;
    matchedExample: string;
    excluded: boolean;
  }> = [];

  for (const rb of candidates) {
    let bestScore = 0;
    let bestExample = "";

    for (const example of rb.intent.examples) {
      const score = jaccardSimilarity(reqTokens, tokenize(example));
      if (score > bestScore) {
        bestScore = score;
        bestExample = example;
      }
    }

    let excluded = false;
    for (const exclude of rb.intent.excludes) {
      const excScore = jaccardSimilarity(reqTokens, tokenize(exclude));
      if (excScore > bestScore) {
        excluded = true;
        break;
      }
    }

    scored.push({
      name: rb.name,
      runbook: rb,
      confidence: bestScore,
      matchedExample: bestExample,
      excluded,
    });
  }

  scored.sort((a, b) => b.confidence - a.confidence);
  const candidateList = scored.map((s) => ({
    name: s.name,
    confidence: s.confidence,
  }));

  const best = scored[0];
  if (!best || best.confidence < minConfidence) {
    return {
      result: null,
      reason: "below-threshold",
      candidates: candidateList,
    };
  }

  if (best.excluded) {
    return {
      result: null,
      reason: "excluded",
      candidates: candidateList,
    };
  }

  if (scored.length > 1) {
    const second = scored[1];
    if (best.confidence - second.confidence < AMBIGUITY_GAP) {
      return {
        result: null,
        reason: "ambiguous",
        candidates: candidateList,
      };
    }
  }

  return {
    result: {
      runbook: best.runbook,
      confidence: best.confidence,
      matchedExample: best.matchedExample,
    },
  };
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1),
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
