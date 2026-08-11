import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  renderRunbookTemplate,
  renderAgentExtensionProposal,
  generateProposalReport,
  type AuthoringContext,
} from "./authoring.ts";
import { classifyReusablePattern } from "./classifier.ts";
import type { PromotionCandidate } from "./types.ts";
import type { RunbookRunEvidence } from "./evidence.ts";
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

describe("runbook authoring", () => {
  beforeEach(() => {
    registerAgentIdentity("db-executioner", {
      username: "DB",
      iconEmoji: ":db:",
    });
  });

  afterEach(() => {
    delete AGENT_IDENTITIES["db-executioner"];
  });

  describe("renderRunbookTemplate", () => {
    it("valid candidate renders ok: true with content string", () => {
      const result = renderRunbookTemplate(makeContext());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(typeof result.content).toBe("string");
      expect(result.content.length).toBeGreaterThan(0);
    });

    it("rendered content starts with frontmatter delimiter", () => {
      const result = renderRunbookTemplate(makeContext());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.content.startsWith("---")).toBe(true);
    });

    it("rendered content contains schemaVersion: 1", () => {
      const result = renderRunbookTemplate(makeContext());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.content).toContain("schemaVersion: 1");
    });

    it("rendered filename is kebab-case ending in .runbook.md", () => {
      const result = renderRunbookTemplate(makeContext());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.filename).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*\.runbook\.md$/);
    });

    it("name is max 50 chars with a very long normalizedIntent", () => {
      const longIntent =
        "transfer all data from one very long account name to another extremely long account name with extra details";
      const ctx = makeContext({
        candidate: makeCandidate({ normalizedIntent: longIntent }),
      });
      const result = renderRunbookTemplate(ctx);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // filename = name + ".runbook.md", so name = filename minus suffix
      const name = result.filename.replace(/\.runbook\.md$/, "");
      expect(name.length).toBeLessThanOrEqual(50);
    });

    it("high-risk candidate content contains approval required: true", () => {
      const ctx = makeContext({
        candidate: makeCandidate({ risk: "production-write" }),
      });
      const result = renderRunbookTemplate(ctx);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.content).toContain("approval:");
      expect(result.content).toContain("required: true");
    });

    it("read-only risk sets verification required to false", () => {
      const ctx = makeContext({
        candidate: makeCandidate({ risk: "read-only" }),
      });
      const result = renderRunbookTemplate(ctx);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // verification section should say required: false
      const verificationMatch = result.content.match(
        /verification:\n\s+required:\s+(true|false)/,
      );
      expect(verificationMatch).not.toBeNull();
      expect(verificationMatch![1]).toBe("false");
    });

    it("production-write risk sets verification required to true", () => {
      const ctx = makeContext({
        candidate: makeCandidate({ risk: "production-write" }),
      });
      const result = renderRunbookTemplate(ctx);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const verificationMatch = result.content.match(
        /verification:\n\s+required:\s+(true|false)/,
      );
      expect(verificationMatch).not.toBeNull();
      expect(verificationMatch![1]).toBe("true");
    });

    it("empty normalizedIntent returns ok: false with reason", () => {
      const ctx = makeContext({
        candidate: makeCandidate({ normalizedIntent: "" }),
      });
      const result = renderRunbookTemplate(ctx);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(typeof result.reason).toBe("string");
      expect(result.reason.length).toBeGreaterThan(0);
    });

    it("validationErrors is an array for valid output", () => {
      const result = renderRunbookTemplate(makeContext());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(Array.isArray(result.validationErrors)).toBe(true);
    });

    it("zero validation errors when ownerAgent is catalog agent 'build'", () => {
      const ctx = makeContext({
        candidate: makeCandidate({ ownerAgent: "build" }),
      });
      const result = renderRunbookTemplate(ctx);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.validationErrors).toHaveLength(0);
    });

    it("content does not contain secret patterns", () => {
      const ctx = makeContext();
      const result = renderRunbookTemplate(ctx);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const secretPatterns = [
        /mongodb\+srv:\/\//i,
        /Bearer\s+[A-Za-z0-9\-._~+/]+=*/,
        /\bsk-[A-Za-z0-9]{20,}/,
        /\bghp_[A-Za-z0-9]{36,}/,
        /\bgho_[A-Za-z0-9]{36,}/,
        /password\s*[:=]\s*\S+/i,
        /\bAKIA[0-9A-Z]{16}\b/,
      ];

      for (const pattern of secretPatterns) {
        expect(pattern.test(result.content)).toBe(false);
      }
    });

    it("with inferredInputs, inputs section appears in rendered content", () => {
      const ctx = makeContext({
        inferredInputs: [
          {
            name: "userId",
            type: "objectId",
            required: true,
            description: "the target user",
          },
          {
            name: "dryRun",
            type: "boolean",
            required: false,
          },
        ],
      });
      const result = renderRunbookTemplate(ctx);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.content).toContain("inputs:");
      expect(result.content).toContain("name: userId");
      expect(result.content).toContain("type: objectId");
      expect(result.content).toContain("required: true");
      expect(result.content).toContain("description: the target user");
      expect(result.content).toContain("name: dryRun");
      expect(result.content).toContain("type: boolean");
    });

    it("with inferredCapabilities, capabilities appear in content", () => {
      const ctx = makeContext({
        inferredCapabilities: ["mongo.read", "slack.post"],
      });
      const result = renderRunbookTemplate(ctx);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.content).toContain("capabilities:");
      expect(result.content).toContain("- mongo.read");
      expect(result.content).toContain("- slack.post");
    });

    it("with inferredVerificationAssertions, assertions appear in content", () => {
      const ctx = makeContext({
        inferredVerificationAssertions: [
          "data was transferred",
          "old account has zero items",
        ],
      });
      const result = renderRunbookTemplate(ctx);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.content).toContain("assertions:");
      expect(result.content).toContain("- data was transferred");
      expect(result.content).toContain("- old account has zero items");
    });

    it("with procedureMemory, prompt body references them", () => {
      const ctx = makeContext({
        procedureMemory: [
          "always verify the account exists first",
          "use bulk operations for large transfers",
        ],
      });
      const result = renderRunbookTemplate(ctx);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.content).toContain(
        "always verify the account exists first",
      );
      expect(result.content).toContain(
        "use bulk operations for large transfers",
      );
      expect(result.content).toContain("Reference procedure notes:");
    });

    it("metadata contains templateVersion, generatedAt, and sourceFingerprint", () => {
      const result = renderRunbookTemplate(makeContext());
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.metadata.templateVersion).toBe("1.0");
      expect(typeof result.metadata.generatedAt).toBe("number");
      expect(result.metadata.sourceFingerprint).toBe("fp-test");
    });

    it("renders with db-executioner ownerAgent after registration", () => {
      const ctx = makeContext({
        candidate: makeCandidate({ ownerAgent: "db-executioner" }),
      });
      const result = renderRunbookTemplate(ctx);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.content).toContain("ownerAgent: db-executioner");
      // db-executioner is registered as persistent agent via registerAgentIdentity,
      // so the validator should not flag ownerAgent as unknown
      const ownerErrors = result.validationErrors.filter(
        (e) => e.field === "ownerAgent",
      );
      expect(ownerErrors).toHaveLength(0);
    });
  });

  describe("renderAgentExtensionProposal", () => {
    it("returns targetAgent matching candidate.ownerAgent", () => {
      const ctx = makeContext();
      const proposal = renderAgentExtensionProposal(ctx);
      expect(proposal.targetAgent).toBe(ctx.candidate.ownerAgent);
    });

    it("returns non-empty description and reason", () => {
      const proposal = renderAgentExtensionProposal(makeContext());
      expect(proposal.description.length).toBeGreaterThan(0);
      expect(proposal.reason.length).toBeGreaterThan(0);
    });

    it("suggestedRouting contains normalizedIntent", () => {
      const intent = "transfer data from one account to another";
      const ctx = makeContext({
        candidate: makeCandidate({ normalizedIntent: intent }),
      });
      const proposal = renderAgentExtensionProposal(ctx);
      expect(proposal.suggestedRouting).toContain(intent);
    });

    it("suggestedCapabilities uses inferredCapabilities when provided", () => {
      const ctx = makeContext({
        inferredCapabilities: ["mongo.read", "github.read"],
      });
      const proposal = renderAgentExtensionProposal(ctx);
      expect(proposal.suggestedCapabilities).toEqual([
        "mongo.read",
        "github.read",
      ]);
    });

    it("suggestedCapabilities falls back to candidate.capabilities", () => {
      const ctx = makeContext({
        candidate: makeCandidate({ capabilities: ["slack.read"] }),
      });
      // no inferredCapabilities set
      const proposal = renderAgentExtensionProposal(ctx);
      expect(proposal.suggestedCapabilities).toEqual(["slack.read"]);
    });

    it("description mentions the ownerAgent name", () => {
      const ctx = makeContext({
        candidate: makeCandidate({ ownerAgent: "build" }),
      });
      const proposal = renderAgentExtensionProposal(ctx);
      expect(proposal.description).toContain("build");
    });

    it("reason includes successfulCount", () => {
      const ctx = makeContext({
        candidate: makeCandidate({ successfulCount: 5 }),
      });
      const proposal = renderAgentExtensionProposal(ctx);
      expect(proposal.reason).toContain("5");
    });
  });

  describe("generateProposalReport", () => {
    function makeReport(
      contextOverrides?: Partial<AuthoringContext>,
      classificationOverrides?: Partial<
        ReturnType<typeof classifyReusablePattern>
      >,
    ) {
      const ctx = makeContext(contextOverrides);
      const rendered = renderRunbookTemplate(ctx);
      const classification = {
        classification: "runbook" as const,
        confidence: 0.75,
        reason: "repeated ordered procedure within existing owner capability boundary",
        ...classificationOverrides,
      };
      return generateProposalReport(ctx, rendered, classification);
    }

    it("report has all required fields", () => {
      const report = makeReport();
      expect(typeof report.artifactClass).toBe("string");
      expect(typeof report.reason).toBe("string");
      expect(typeof report.riskClassification).toBe("string");
      expect(Array.isArray(report.existingConsidered)).toBe(true);
      expect(Array.isArray(report.executionEvidence)).toBe(true);
      expect(Array.isArray(report.linkedProcedureMemory)).toBe(true);
      expect(Array.isArray(report.positiveExamples)).toBe(true);
      expect(Array.isArray(report.negativeExamples)).toBe(true);
      expect(Array.isArray(report.requestedCapabilities)).toBe(true);
      expect(Array.isArray(report.humanGates)).toBe(true);
      expect(Array.isArray(report.validationOutput)).toBe(true);
      expect(typeof report.verificationBehavior).toBe("string");
      expect(typeof report.rollbackBehavior).toBe("string");
    });

    it("high-risk candidate has non-empty humanGates", () => {
      const report = makeReport({
        candidate: makeCandidate({ risk: "production-write" }),
      });
      expect(report.humanGates.length).toBeGreaterThan(0);
      expect(report.humanGates[0]).toContain("production-write");
    });

    it("read-only risk has empty humanGates", () => {
      const report = makeReport({
        candidate: makeCandidate({ risk: "read-only" }),
      });
      expect(report.humanGates).toHaveLength(0);
    });

    it("report includes execution evidence entries", () => {
      const evidence = [
        makeEvidence({ runId: "run-a", status: "completed" }),
        makeEvidence({ runId: "run-b", status: "failed" }),
      ];
      const report = makeReport({ executionEvidence: evidence });
      expect(report.executionEvidence).toHaveLength(2);
      expect(report.executionEvidence[0].runId).toBe("run-a");
      expect(report.executionEvidence[0].status).toBe("completed");
      expect(report.executionEvidence[1].runId).toBe("run-b");
      expect(report.executionEvidence[1].status).toBe("failed");
    });

    it("report includes linked procedure memory", () => {
      const report = makeReport({
        procedureMemory: ["always backup first", "verify after transfer"],
      });
      expect(report.linkedProcedureMemory).toEqual([
        "always backup first",
        "verify after transfer",
      ]);
    });

    it("positiveExamples and negativeExamples are non-empty", () => {
      const report = makeReport();
      expect(report.positiveExamples.length).toBeGreaterThan(0);
      expect(report.negativeExamples.length).toBeGreaterThan(0);
    });

    it("validationOutput comes from the rendered result", () => {
      // Valid candidate with build ownerAgent should have zero validation errors
      const report = makeReport({
        candidate: makeCandidate({ ownerAgent: "build" }),
      });
      expect(report.validationOutput).toHaveLength(0);
    });

    it("validationOutput is empty array when rendered fails", () => {
      const ctx = makeContext({
        candidate: makeCandidate({ normalizedIntent: "" }),
      });
      const rendered = renderRunbookTemplate(ctx);
      // rendered is ok: false
      expect(rendered.ok).toBe(false);
      const classification = {
        classification: "runbook" as const,
        confidence: 0.75,
        reason: "test",
      };
      const report = generateProposalReport(ctx, rendered, classification);
      expect(report.validationOutput).toHaveLength(0);
    });

    it("destructive risk produces humanGates and rollback plan required", () => {
      const report = makeReport({
        candidate: makeCandidate({ risk: "destructive" }),
      });
      expect(report.humanGates.length).toBeGreaterThan(0);
      expect(report.rollbackBehavior).toContain("rollback plan required");
    });

    it("riskClassification matches candidate risk", () => {
      const report = makeReport({
        candidate: makeCandidate({ risk: "credential" }),
      });
      expect(report.riskClassification).toBe("credential");
    });

    it("artifactClass and reason come from classification", () => {
      const report = makeReport(undefined, {
        classification: "agent-extension",
        reason: "owner lacks capability X",
      });
      expect(report.artifactClass).toBe("agent-extension");
      expect(report.reason).toBe("owner lacks capability X");
    });

    it("existingConsidered populated when classification has existingMatch", () => {
      const report = makeReport(undefined, {
        existingMatch: { name: "old-runbook", kind: "runbook" },
      });
      expect(report.existingConsidered).toHaveLength(1);
      expect(report.existingConsidered[0].name).toBe("old-runbook");
      expect(report.existingConsidered[0].kind).toBe("runbook");
      expect(report.existingConsidered[0].whyNotSufficient.length).toBeGreaterThan(0);
    });

    it("existingConsidered empty when classification has no existingMatch", () => {
      const report = makeReport(undefined, {
        existingMatch: undefined,
      });
      expect(report.existingConsidered).toHaveLength(0);
    });

    it("requestedCapabilities uses inferredCapabilities when available", () => {
      const report = makeReport({
        inferredCapabilities: ["mongo.read", "slack.post"],
      });
      expect(report.requestedCapabilities).toEqual(["mongo.read", "slack.post"]);
    });

    it("read-only verification behavior says no verification required", () => {
      const report = makeReport({
        candidate: makeCandidate({ risk: "read-only" }),
      });
      expect(report.verificationBehavior).toContain("no verification required");
    });

    it("non-read-only verification behavior says verification required", () => {
      const report = makeReport({
        candidate: makeCandidate({ risk: "workspace-write" }),
      });
      expect(report.verificationBehavior).toContain("verification required");
    });
  });
});
