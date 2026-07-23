import { matchRunbook } from "./matcher.ts";

export interface EvaluationFixture {
  request: string;
  shouldMatch: boolean;
  expectedRunbook?: string;
  context?: Record<string, string>;
}

export interface EvaluationResult {
  fixture: EvaluationFixture;
  actualMatch: boolean;
  matchedRunbook: string | null;
  confidence: number;
  passed: boolean;
}

export interface EvaluationSuiteResult {
  total: number;
  passed: number;
  failed: number;
  accuracy: number;
  results: EvaluationResult[];
}

export function runEvaluationSuite(
  fixtures: EvaluationFixture[],
  options?: { runbookName?: string },
): EvaluationSuiteResult {
  const results: EvaluationResult[] = [];

  for (const fixture of fixtures) {
    const match = matchRunbook(fixture.request, {
      minConfidence: 0.4,
    });

    const actualMatch = match !== null;
    const matchedRunbook = match?.runbook.name ?? null;
    const confidence = match?.confidence ?? 0;

    let passed: boolean;
    if (fixture.shouldMatch) {
      passed =
        actualMatch &&
        (!fixture.expectedRunbook || matchedRunbook === fixture.expectedRunbook);
    } else {
      passed = !actualMatch;
    }

    if (options?.runbookName && matchedRunbook !== null && matchedRunbook !== options.runbookName) {
      passed = !fixture.shouldMatch;
    }

    results.push({
      fixture,
      actualMatch,
      matchedRunbook,
      confidence,
      passed,
    });
  }

  const passedCount = results.filter((r) => r.passed).length;
  return {
    total: results.length,
    passed: passedCount,
    failed: results.length - passedCount,
    accuracy: results.length > 0 ? passedCount / results.length : 0,
    results,
  };
}
