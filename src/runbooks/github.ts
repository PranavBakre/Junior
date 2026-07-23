import type { AuthoringResult, ProposalReport } from "./authoring.ts";

export type PrCreationResult =
  | {
      ok: true;
      prUrl: string;
      branchName: string;
      filePath: string;
      prBody: string;
    }
  | { ok: false; reason: string };

const PRIVATE_REPO = "GrowthX-Club/junior-private-agents";

export async function createRunbookPr(
  rendered: AuthoringResult,
  report: ProposalReport,
  options?: {
    dryRun?: boolean;
    ghAccount?: string;
  },
): Promise<PrCreationResult> {
  if (!rendered.ok) {
    return { ok: false, reason: `rendered content is invalid: ${rendered.reason}` };
  }

  const dryRun = options?.dryRun ?? true;
  const name = rendered.filename.replace(/\.runbook\.md$/, "");
  const branchName = `runbook/${name}`;
  const filePath = `runbooks/${rendered.filename}`;
  const prBody = formatPrBody(report);

  if (dryRun) {
    return {
      ok: true,
      prUrl: `https://github.com/${PRIVATE_REPO}/pull/dry-run`,
      branchName,
      filePath,
      prBody,
    };
  }

  return {
    ok: false,
    reason: "live PR creation not yet implemented — use dryRun: true",
  };
}

function formatPrBody(report: ProposalReport): string {
  const lines: string[] = [];

  lines.push(`## Runbook Proposal`);
  lines.push(``);
  lines.push(`**Artifact class:** ${report.artifactClass}`);
  lines.push(`**Reason:** ${report.reason}`);
  lines.push(`**Risk:** ${report.riskClassification}`);
  lines.push(``);

  if (report.existingConsidered.length > 0) {
    lines.push(`### Existing definitions considered`);
    for (const e of report.existingConsidered) {
      lines.push(`- **${e.name}** (${e.kind}): ${e.whyNotSufficient}`);
    }
    lines.push(``);
  }

  if (report.executionEvidence.length > 0) {
    lines.push(`### Execution evidence`);
    for (const e of report.executionEvidence) {
      lines.push(`- \`${e.runId}\`: ${e.status} (${new Date(e.date).toISOString()})`);
    }
    lines.push(``);
  }

  if (report.linkedProcedureMemory.length > 0) {
    lines.push(`### Linked procedure memory`);
    for (const m of report.linkedProcedureMemory) {
      lines.push(`- ${m}`);
    }
    lines.push(``);
  }

  if (report.positiveExamples.length > 0) {
    lines.push(`### Routing examples (should match)`);
    for (const ex of report.positiveExamples) {
      lines.push(`- ${ex}`);
    }
    lines.push(``);
  }

  if (report.negativeExamples.length > 0) {
    lines.push(`### Routing examples (should NOT match)`);
    for (const ex of report.negativeExamples) {
      lines.push(`- ${ex}`);
    }
    lines.push(``);
  }

  if (report.requestedCapabilities.length > 0) {
    lines.push(`### Capabilities`);
    lines.push(report.requestedCapabilities.map((c) => `\`${c}\``).join(", "));
    lines.push(``);
  }

  if (report.humanGates.length > 0) {
    lines.push(`### Human gates`);
    for (const g of report.humanGates) {
      lines.push(`- ${g}`);
    }
    lines.push(``);
  }

  lines.push(`### Verification`);
  lines.push(report.verificationBehavior);
  lines.push(``);
  lines.push(`### Rollback`);
  lines.push(report.rollbackBehavior);

  if (report.validationOutput.length > 0) {
    lines.push(``);
    lines.push(`### Validation warnings`);
    for (const v of report.validationOutput) {
      lines.push(`- **${v.field}**: ${v.message}`);
    }
  }

  return lines.join("\n");
}
