import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import path from "node:path";
import {
  AGENT_IDENTITIES,
  registerAgentIdentity,
} from "../support/agents.ts";
import {
  clearRegistryForTests,
  loadRunbookRegistryFromDir,
} from "./registry.ts";
import { matchRunbook, matchRunbookDetailed } from "./matcher.ts";

const FIXTURE_DIR = path.join(import.meta.dir, "__fixtures__");

describe("runbook matcher", () => {
  beforeEach(async () => {
    registerAgentIdentity("db-executioner", {
      username: "DB Executioner",
      iconEmoji: ":database:",
    });
    clearRegistryForTests();
    await loadRunbookRegistryFromDir(FIXTURE_DIR, "private");
  });

  afterEach(() => {
    delete AGENT_IDENTITIES["db-executioner"];
    clearRegistryForTests();
  });

  describe("matchRunbook", () => {
    it("selects transfer-ai-roadmaps for a close intent match", () => {
      const result = matchRunbook(
        "move all AI roadmaps from one account to another",
      );
      expect(result).not.toBeNull();
      expect(result!.runbook.name).toBe("transfer-ai-roadmaps");
      expect(result!.confidence).toBeGreaterThan(0.6);
    });

    it("selects transfer-ai-roadmaps for a variant phrasing", () => {
      const result = matchRunbook(
        "transfer AI roadmaps from user A to user B",
      );
      expect(result).not.toBeNull();
      expect(result!.runbook.name).toBe("transfer-ai-roadmaps");
      expect(result!.confidence).toBeGreaterThan(0.6);
    });

    it("selects for a rephrased request that shares enough tokens", () => {
      const result = matchRunbook(
        "move all AI roadmaps from account A to another account",
      );
      expect(result).not.toBeNull();
      expect(result!.runbook.name).toBe("transfer-ai-roadmaps");
    });

    it("does NOT select for 'move one Notion roadmap' (excluded phrase)", () => {
      const result = matchRunbook("move one Notion roadmap");
      expect(result).toBeNull();
    });

    it("does NOT select for 'transfer every document owned by A'", () => {
      const result = matchRunbook("transfer every document owned by A");
      expect(result).toBeNull();
    });

    it("returns null for a completely unrelated request", () => {
      const result = matchRunbook(
        "unrelated task about cooking a nice meal for dinner",
      );
      expect(result).toBeNull();
    });

    it("filters by ownerAgent", () => {
      const result = matchRunbook(
        "move all AI roadmaps from one account to another",
        { ownerAgent: "build" },
      );
      // db-executioner != build, so no match
      expect(result).toBeNull();
    });

    it("filters by riskCeiling (excludes production-write runbooks)", () => {
      const result = matchRunbook(
        "move all AI roadmaps from one account to another",
        { riskCeiling: "workspace-write" },
      );
      // transfer-ai-roadmaps is production-write, ceiling is workspace-write
      expect(result).toBeNull();
    });

    it("respects minConfidence option", () => {
      // "transfer AI roadmaps" shares partial tokens with the example
      // "transfer AI roadmaps from user A to user B", giving a moderate
      // Jaccard score (below default 0.6 but above 0.3).
      const partialRequest = "transfer AI roadmaps";

      // Default threshold (0.6) rejects the partial match
      const defaultResult = matchRunbook(partialRequest);
      expect(defaultResult).toBeNull();

      // Lowering minConfidence to 0.3 accepts it
      const lowResult = matchRunbook(partialRequest, { minConfidence: 0.3 });
      expect(lowResult).not.toBeNull();
      expect(lowResult!.runbook.name).toBe("transfer-ai-roadmaps");
    });
  });

  describe("matchRunbookDetailed", () => {
    it("returns 'excluded' reason when exclusion fires", () => {
      // Use low minConfidence so we don't hit below-threshold first
      const { result, reason, candidates } = matchRunbookDetailed(
        "move one Notion roadmap",
        { minConfidence: 0.1 },
      );
      expect(result).toBeNull();
      expect(reason).toBe("excluded");
      expect(candidates).toBeDefined();
    });

    it("returns 'below-threshold' reason for a weak match", () => {
      const { result, reason, candidates } = matchRunbookDetailed(
        "unrelated task about cooking a nice meal for dinner",
      );
      expect(result).toBeNull();
      expect(reason).toBe("below-threshold");
      expect(candidates).toBeDefined();
    });

    it("returns candidates list with names and confidences", () => {
      const { candidates } = matchRunbookDetailed(
        "move all AI roadmaps from one account to another",
      );
      // Even on a successful match, candidates may or may not be present.
      // On a failed match, candidates should always be present.
      const failed = matchRunbookDetailed(
        "unrelated task about cooking a nice meal for dinner",
      );
      expect(failed.candidates).toBeDefined();
      expect(failed.candidates!.length).toBeGreaterThanOrEqual(1);
      expect(failed.candidates![0]).toHaveProperty("name");
      expect(failed.candidates![0]).toHaveProperty("confidence");
    });

    it("returns a successful result for a strong match", () => {
      const { result, reason } = matchRunbookDetailed(
        "move all AI roadmaps from one account to another",
      );
      expect(result).not.toBeNull();
      expect(result!.runbook.name).toBe("transfer-ai-roadmaps");
      expect(result!.confidence).toBeGreaterThan(0.6);
      expect(reason).toBeUndefined();
    });

    it("returns 'risk-ceiling' when all runbooks exceed the ceiling", () => {
      const { result, reason } = matchRunbookDetailed(
        "move all AI roadmaps from one account to another",
        { riskCeiling: "read-only" },
      );
      expect(result).toBeNull();
      expect(reason).toBe("risk-ceiling");
    });
  });
});
