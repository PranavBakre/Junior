import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createRunbookPr } from "./github.ts";
import {
  renderRunbookTemplate,
  generateProposalReport,
  type AuthoringContext,
  type AuthoringResult,
} from "./authoring.ts";
import { classifyReusablePattern } from "./classifier.ts";
import type { PromotionCandidate } from "./types.ts";
import type { RunbookRunEvidence } from "./evidence.ts";
import type { ProposalReport } from "./authoring.ts";
import {
  AGENT_IDENTITIES,
  registerAgentIdentity,
} from "../support/agents.ts";

function makeCandidate(
  overrides?: Partial<PromotionCandidate>,
): PromotionCandidate {
  return {
    fingerprint: "fp-test",
    proposedKind: "runbook",
    normalizedIntent: "transfer data from one account to another",
    ownerAgent: "build",
    occurrenceCount: 3,
    successfulCount: 3,
    firstSeenAt: Date.now(),
    lastSeenAt: Date.now(),
    evidenceRefs: ["run-1", "run-2", "run-3"],
    procedureMemoryIds: [],
    status: "tracking",
    risk: "production-write",
    capabilities: ["mongo.read"],
    ...overrides,
  };
}

function makeEvidence(
  overrides?: Partial<RunbookRunEvidence>,
): RunbookRunEvidence {
  return {
    runId: "run-1",
    runbookName: "test",
    contentDigest: "abc",
    ownerAgent: "build",
    risk: "production-write",
    boundInputs: {},
    status: "completed",
    startedAt: Date.now(),
    intentFingerprint: "fp-test",
    ...overrides,
  };
}

function makeContext(
  overrides?: Partial<AuthoringContext>,
): AuthoringContext {
  return {
    candidate: makeCandidate(),
    executionEvidence: [makeEvidence()],
    ...overrides,
  };
}

/** Build a valid rendered result and proposal report for PR tests. */
function buildRenderedAndReport(
  contextOverrides?: Partial<AuthoringContext>,
): { rendered: AuthoringResult; report: ProposalReport } {
  const ctx = makeContext(contextOverrides);
  const rendered = renderRunbookTemplate(ctx);
  const classification = classifyReusablePattern(
    ctx.candidate.normalizedIntent,
    ctx.candidate.ownerAgent,
    ctx.candidate.risk,
    ctx.candidate.capabilities,
    ctx.candidate.occurrenceCount,
  );
  const report = generateProposalReport(ctx, rendered, classification);
  return { rendered, report };
}

describe("runbook github PR creation", () => {
  beforeEach(() => {
    registerAgentIdentity("db-executioner", {
      username: "DB",
      iconEmoji: ":db:",
    });
  });

  afterEach(() => {
    delete AGENT_IDENTITIES["db-executioner"];
  });

  describe("createRunbookPr", () => {
    it("dry-run returns ok: true with prUrl, branchName, filePath, prBody", async () => {
      const { rendered, report } = buildRenderedAndReport();
      const result = await createRunbookPr(rendered, report, { dryRun: true });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(typeof result.prUrl).toBe("string");
      expect(typeof result.branchName).toBe("string");
      expect(typeof result.filePath).toBe("string");
      expect(typeof result.prBody).toBe("string");
    });

    it("branchName is runbook/<name>", async () => {
      const { rendered, report } = buildRenderedAndReport();
      const result = await createRunbookPr(rendered, report, { dryRun: true });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.branchName).toMatch(/^runbook\/[a-z0-9-]+$/);
      // Verify it matches the name derived from the rendered filename
      const expectedName = (rendered as Extract<AuthoringResult, { ok: true }>)
        .filename.replace(/\.runbook\.md$/, "");
      expect(result.branchName).toBe(`runbook/${expectedName}`);
    });

    it("filePath is runbooks/<name>.runbook.md", async () => {
      const { rendered, report } = buildRenderedAndReport();
      const result = await createRunbookPr(rendered, report, { dryRun: true });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.filePath).toMatch(/^runbooks\/[a-z0-9-]+\.runbook\.md$/);
    });

    it("prBody contains 'Runbook Proposal' heading", async () => {
      const { rendered, report } = buildRenderedAndReport();
      const result = await createRunbookPr(rendered, report, { dryRun: true });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.prBody).toContain("## Runbook Proposal");
    });

    it("prBody contains risk classification", async () => {
      const { rendered, report } = buildRenderedAndReport({
        candidate: makeCandidate({ risk: "destructive" }),
      });
      const result = await createRunbookPr(rendered, report, { dryRun: true });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.prBody).toContain("destructive");
    });

    it("prBody contains execution evidence section", async () => {
      const evidence = [
        makeEvidence({ runId: "run-ev-1", status: "completed" }),
        makeEvidence({ runId: "run-ev-2", status: "completed" }),
      ];
      const { rendered, report } = buildRenderedAndReport({
        executionEvidence: evidence,
      });
      const result = await createRunbookPr(rendered, report, { dryRun: true });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.prBody).toContain("### Execution evidence");
      expect(result.prBody).toContain("run-ev-1");
      expect(result.prBody).toContain("run-ev-2");
    });

    it("invalid rendered input (ok: false) returns ok: false", async () => {
      const failedRendered: AuthoringResult = {
        ok: false,
        reason: "could not derive name",
      };
      const { report } = buildRenderedAndReport();
      const result = await createRunbookPr(failedRendered, report, {
        dryRun: true,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain("rendered content is invalid");
    });

    it("non-dry-run (dryRun: false) returns ok: false with 'not yet implemented'", async () => {
      const { rendered, report } = buildRenderedAndReport();
      const result = await createRunbookPr(rendered, report, {
        dryRun: false,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain("not yet implemented");
    });

    it("prBody contains verification and rollback sections", async () => {
      const { rendered, report } = buildRenderedAndReport();
      const result = await createRunbookPr(rendered, report, { dryRun: true });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.prBody).toContain("### Verification");
      expect(result.prBody).toContain("### Rollback");
    });

    it("prBody contains human gates for high-risk candidates", async () => {
      const { rendered, report } = buildRenderedAndReport({
        candidate: makeCandidate({ risk: "payment" }),
      });
      const result = await createRunbookPr(rendered, report, { dryRun: true });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.prBody).toContain("### Human gates");
    });

    it("prBody contains capabilities section", async () => {
      const { rendered, report } = buildRenderedAndReport({
        candidate: makeCandidate({ capabilities: ["mongo.read"] }),
      });
      const result = await createRunbookPr(rendered, report, { dryRun: true });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.prBody).toContain("### Capabilities");
      expect(result.prBody).toContain("`mongo.read`");
    });

    it("default dryRun is true when options omitted", async () => {
      const { rendered, report } = buildRenderedAndReport();
      const result = await createRunbookPr(rendered, report);
      // No options = dryRun defaults to true
      expect(result.ok).toBe(true);
    });

    it("prBody contains routing examples", async () => {
      const { rendered, report } = buildRenderedAndReport();
      const result = await createRunbookPr(rendered, report, { dryRun: true });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.prBody).toContain("### Routing examples (should match)");
      expect(result.prBody).toContain(
        "### Routing examples (should NOT match)",
      );
    });
  });
});
