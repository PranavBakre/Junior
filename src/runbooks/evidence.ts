import type { RunbookDefinition, RunbookRisk } from "./types.ts";
import { redactBoundInputs } from "./binder.ts";

export interface RunbookRunEvidence {
  runId: string;
  runbookName: string;
  contentDigest: string;
  ownerAgent: string;
  risk: RunbookRisk;
  boundInputs: Record<string, string>;
  approvalRef?: string;
  status:
    | "selected"
    | "approved"
    | "executing"
    | "completed"
    | "failed"
    | "rejected";
  verificationResults?: string[];
  startedAt: number;
  completedAt?: number;
  intentFingerprint: string;
}

export function createRunEvidence(
  runbook: RunbookDefinition,
  boundInputs: Record<string, string | number | boolean>,
  request: string,
  startedAt: number,
): RunbookRunEvidence {
  return {
    runId: generateRunId(),
    runbookName: runbook.name,
    contentDigest: runbook.contentDigest,
    ownerAgent: runbook.ownerAgent,
    risk: runbook.risk,
    boundInputs: redactBoundInputs(boundInputs, runbook),
    status: "selected",
    startedAt,
    intentFingerprint: createIntentFingerprint(request, runbook),
  };
}

export function createIntentFingerprint(
  request: string,
  runbook: RunbookDefinition,
): string {
  const normalized = normalizeForFingerprint(request);
  const components = [
    normalized,
    runbook.ownerAgent,
    runbook.risk,
    runbook.capabilities.sort().join(","),
    `approval:${runbook.approval.required}:${runbook.approval.afterSteps?.length ?? 0}`,
    `verification:${runbook.verification.required}:${runbook.verification.assertions.length}`,
  ];

  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(components.join("|"));
  return hasher.digest("hex");
}

const NAME_PATTERN = /\b[A-Z][a-z]+ [A-Z][a-z]+\b/g;

const PII_PATTERNS = [
  /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/g,
  /\b[a-f0-9]{24}\b/g,
  /\b\d{10,}\b/g,
];

export function normalizeForFingerprint(text: string): string {
  let normalized = text.trim().replace(NAME_PATTERN, "<REDACTED>").toLowerCase();
  for (const pattern of PII_PATTERNS) {
    normalized = normalized.replace(pattern, "<REDACTED>");
  }
  return normalized
    .replace(/[^\w\s<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function generateRunId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ProcedureFallback {
  query: string;
  warning: string;
}

export function buildProcedureFallback(request: string): ProcedureFallback {
  return {
    query: request
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
    warning:
      "No reviewed runbook found. Recalling procedure memory — treat as hypothesis, not execution authority.",
  };
}
