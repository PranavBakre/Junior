import type { ClassificationResult } from "./classifier.ts";
import type { RunbookRunEvidence } from "./evidence.ts";
import { validateRunbook } from "./validator.ts";
import { HIGH_RISK_KINDS, type PromotionCandidate, type RunbookDefinition, type RunbookRisk, type RunbookValidationError } from "./types.ts";

export interface AuthoringContext {
  candidate: PromotionCandidate;
  executionEvidence: RunbookRunEvidence[];
  procedureMemory?: string[];
  inferredInputs?: Array<{
    name: string;
    type: string;
    required: boolean;
    description?: string;
  }>;
  inferredCapabilities?: string[];
  inferredVerificationAssertions?: string[];
}

export type AuthoringResult =
  | {
      ok: true;
      content: string;
      filename: string;
      validationErrors: RunbookValidationError[];
      metadata: {
        templateVersion: string;
        generatedAt: number;
        sourceFingerprint: string;
      };
    }
  | { ok: false; reason: string };

export function renderRunbookTemplate(
  context: AuthoringContext,
): AuthoringResult {
  const { candidate } = context;

  const name = deriveKebabName(candidate.normalizedIntent);
  if (!name) {
    return { ok: false, reason: "could not derive a valid kebab-case name from normalized intent" };
  }

  const risk: RunbookRisk = candidate.risk ?? "production-write";
  const approvalRequired = HIGH_RISK_KINDS.includes(risk) || risk !== "read-only";
  const verificationRequired = risk !== "read-only";

  const capabilities = context.inferredCapabilities ?? candidate.capabilities;
  const inputs = context.inferredInputs ?? [];
  const assertions = context.inferredVerificationAssertions ?? (verificationRequired ? ["operation completed successfully"] : []);

  const intentExamples = candidate.normalizedIntent
    ? [candidate.normalizedIntent]
    : ["perform the described task"];

  const lines: string[] = ["---"];
  lines.push(`schemaVersion: 1`);
  lines.push(`name: ${name}`);
  lines.push(`description: ${candidate.normalizedIntent || "Auto-generated runbook from promotion candidate"}`);
  lines.push(`ownerAgent: ${candidate.ownerAgent}`);
  lines.push(`intent:`);
  lines.push(`  examples:`);
  for (const ex of intentExamples) {
    lines.push(`    - ${ex}`);
  }
  lines.push(`  excludes:`);
  lines.push(`    - unrelated task`);

  if (inputs.length > 0) {
    lines.push(`inputs:`);
    for (const input of inputs) {
      lines.push(`  - name: ${input.name}`);
      lines.push(`    type: ${input.type}`);
      lines.push(`    required: ${input.required}`);
      if (input.description) {
        lines.push(`    description: ${input.description}`);
      }
    }
  } else {
    lines.push(`inputs: []`);
  }

  lines.push(`risk: ${risk}`);
  lines.push(`approval:`);
  lines.push(`  required: ${approvalRequired}`);
  if (capabilities.length > 0) {
    lines.push(`capabilities:`);
    for (const cap of capabilities) {
      lines.push(`  - ${cap}`);
    }
  } else {
    lines.push(`capabilities: []`);
  }
  lines.push(`verification:`);
  lines.push(`  required: ${verificationRequired}`);
  if (assertions.length > 0) {
    lines.push(`  assertions:`);
    for (const a of assertions) {
      lines.push(`    - ${a}`);
    }
  }
  lines.push(`tags:`);
  lines.push(`  - auto-generated`);
  lines.push(`---`);
  lines.push(``);
  lines.push(buildPromptBody(context));
  lines.push(``);

  const content = lines.join("\n");
  const filename = `${name}.runbook.md`;

  const tempDef: RunbookDefinition = {
    schemaVersion: 1,
    name,
    description: candidate.normalizedIntent || "Auto-generated runbook",
    ownerAgent: candidate.ownerAgent,
    intent: { examples: intentExamples, excludes: ["unrelated task"] },
    inputs: inputs.map((i) => ({
      name: i.name,
      type: i.type as RunbookDefinition["inputs"][number]["type"],
      required: i.required,
      description: i.description,
    })),
    risk,
    approval: { required: approvalRequired },
    capabilities,
    verification: { required: verificationRequired, assertions },
    tags: ["auto-generated"],
    prompt: buildPromptBody(context),
    filePath: `runbooks/${filename}`,
    origin: "private",
    contentDigest: "",
  };

  const validationErrors = validateRunbook(tempDef, name);

  return {
    ok: true,
    content,
    filename,
    validationErrors,
    metadata: {
      templateVersion: "1.0",
      generatedAt: Date.now(),
      sourceFingerprint: candidate.fingerprint,
    },
  };
}

export interface AgentExtensionProposal {
  targetAgent: string;
  description: string;
  suggestedRouting: string[];
  suggestedCapabilities: string[];
  reason: string;
}

export function renderAgentExtensionProposal(
  context: AuthoringContext,
): AgentExtensionProposal {
  const { candidate } = context;
  return {
    targetAgent: candidate.ownerAgent,
    description: `Extend ${candidate.ownerAgent} to handle: ${candidate.normalizedIntent}`,
    suggestedRouting: candidate.normalizedIntent
      ? [candidate.normalizedIntent]
      : [],
    suggestedCapabilities: context.inferredCapabilities ?? candidate.capabilities,
    reason: `${candidate.successfulCount} successful executions of this pattern were handled by ${candidate.ownerAgent}, but it lacks the declared capability boundary for this class of work.`,
  };
}

export interface ProposalReport {
  artifactClass: string;
  reason: string;
  existingConsidered: Array<{
    name: string;
    kind: string;
    whyNotSufficient: string;
  }>;
  executionEvidence: Array<{
    runId: string;
    status: string;
    date: number;
  }>;
  linkedProcedureMemory: string[];
  positiveExamples: string[];
  negativeExamples: string[];
  requestedCapabilities: string[];
  riskClassification: string;
  humanGates: string[];
  verificationBehavior: string;
  rollbackBehavior: string;
  validationOutput: RunbookValidationError[];
}

export function generateProposalReport(
  context: AuthoringContext,
  rendered: AuthoringResult,
  classification: ClassificationResult,
): ProposalReport {
  const { candidate, executionEvidence } = context;
  const risk: RunbookRisk = candidate.risk ?? "production-write";
  const isHighRisk = HIGH_RISK_KINDS.includes(risk);

  return {
    artifactClass: classification.classification,
    reason: classification.reason,
    existingConsidered: classification.existingMatch
      ? [
          {
            name: classification.existingMatch.name,
            kind: classification.existingMatch.kind,
            whyNotSufficient: "existing definition does not cover this specific intent pattern",
          },
        ]
      : [],
    executionEvidence: executionEvidence.map((e) => ({
      runId: e.runId,
      status: e.status,
      date: e.startedAt,
    })),
    linkedProcedureMemory: context.procedureMemory ?? [],
    positiveExamples: candidate.normalizedIntent
      ? [candidate.normalizedIntent]
      : [],
    negativeExamples: ["unrelated task"],
    requestedCapabilities: context.inferredCapabilities ?? candidate.capabilities,
    riskClassification: risk,
    humanGates: isHighRisk
      ? [`human approval required before execution (risk: ${risk})`]
      : [],
    verificationBehavior: risk !== "read-only"
      ? "post-execution verification required"
      : "no verification required (read-only)",
    rollbackBehavior: isHighRisk
      ? "rollback plan required before execution"
      : "standard rollback procedure",
    validationOutput: rendered.ok ? rendered.validationErrors : [],
  };
}

function deriveKebabName(intent: string): string | null {
  if (!intent) return null;
  const kebab = intent
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\w\s]/g, "")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  if (!kebab) return null;
  return kebab.slice(0, 50).replace(/-$/, "");
}

function buildPromptBody(context: AuthoringContext): string {
  const parts: string[] = [];
  parts.push("Execute the procedure as described.");

  if (context.procedureMemory && context.procedureMemory.length > 0) {
    parts.push("");
    parts.push("Reference procedure notes:");
    for (const mem of context.procedureMemory) {
      parts.push(`- ${mem}`);
    }
  }

  return parts.join("\n");
}
