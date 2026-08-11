import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import {
  AGENT_IDENTITIES,
  registerAgentIdentity,
} from "../support/agents.ts";
import {
  clearRegistryForTests,
  loadRunbookRegistryFromDir,
} from "./registry.ts";
import {
  runEvaluationSuite,
  type EvaluationFixture,
} from "./evaluation.ts";
import { TRANSFER_AI_ROADMAPS_FIXTURES } from "./__fixtures__/transfer-ai-roadmaps.eval.ts";

const FIXTURE_DIR = path.join(import.meta.dir, "__fixtures__");

describe("evaluation", () => {
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

  describe("default fixtures", () => {
    it("all 7 fixtures pass with 100% accuracy", () => {
      const suite = runEvaluationSuite(TRANSFER_AI_ROADMAPS_FIXTURES);
      expect(suite.accuracy).toBeGreaterThanOrEqual(1.0);
      expect(suite.total).toBe(7);
      expect(suite.passed).toBe(7);
      expect(suite.failed).toBe(0);
    });
  });

  describe("positive fixture", () => {
    it("matches 'move my AI roadmaps' to transfer-ai-roadmaps", () => {
      const fixture: EvaluationFixture = {
        request: "move my AI roadmaps from A to B",
        shouldMatch: true,
        expectedRunbook: "transfer-ai-roadmaps",
      };
      const suite = runEvaluationSuite([fixture]);
      expect(suite.total).toBe(1);
      expect(suite.passed).toBe(1);

      const result = suite.results[0];
      expect(result.passed).toBe(true);
      expect(result.actualMatch).toBe(true);
      expect(result.matchedRunbook).toBe("transfer-ai-roadmaps");
    });
  });

  describe("negative fixture", () => {
    it("'delete all roadmaps' does not match any runbook", () => {
      const fixture: EvaluationFixture = {
        request: "delete all roadmaps",
        shouldMatch: false,
      };
      const suite = runEvaluationSuite([fixture]);
      expect(suite.total).toBe(1);
      expect(suite.passed).toBe(1);

      const result = suite.results[0];
      expect(result.passed).toBe(true);
      expect(result.actualMatch).toBe(false);
    });
  });

  describe("suite result totals", () => {
    it("total matches fixture count and passed matches actual pass count", () => {
      const suite = runEvaluationSuite(TRANSFER_AI_ROADMAPS_FIXTURES);
      expect(suite.total).toBe(TRANSFER_AI_ROADMAPS_FIXTURES.length);
      expect(suite.passed + suite.failed).toBe(suite.total);

      const actualPassed = suite.results.filter((r) => r.passed).length;
      expect(suite.passed).toBe(actualPassed);
    });
  });

  describe("result shape", () => {
    it("each result has fixture, actualMatch, confidence, and passed fields", () => {
      const suite = runEvaluationSuite(TRANSFER_AI_ROADMAPS_FIXTURES);

      for (const result of suite.results) {
        expect(result).toHaveProperty("fixture");
        expect(result).toHaveProperty("actualMatch");
        expect(result).toHaveProperty("confidence");
        expect(result).toHaveProperty("passed");
        expect(result).toHaveProperty("matchedRunbook");

        expect(typeof result.actualMatch).toBe("boolean");
        expect(typeof result.confidence).toBe("number");
        expect(typeof result.passed).toBe("boolean");
        expect(result.fixture).toHaveProperty("request");
        expect(result.fixture).toHaveProperty("shouldMatch");
      }
    });
  });

  describe("custom fixtures", () => {
    it("evaluates inline custom fixtures correctly", () => {
      const customs: EvaluationFixture[] = [
        {
          request:
            "transfer all AI roadmaps from alice@example.com to bob@example.com",
          shouldMatch: true,
          expectedRunbook: "transfer-ai-roadmaps",
        },
        {
          request: "send a birthday email to someone",
          shouldMatch: false,
        },
      ];

      const suite = runEvaluationSuite(customs);
      expect(suite.total).toBe(2);
      expect(suite.results[0].passed).toBe(true);
      expect(suite.results[1].passed).toBe(true);
    });
  });

  describe("empty fixtures", () => {
    it("returns total=0 and accuracy=0 for an empty array", () => {
      const suite = runEvaluationSuite([]);
      expect(suite.total).toBe(0);
      expect(suite.passed).toBe(0);
      expect(suite.failed).toBe(0);
      expect(suite.accuracy).toBe(0);
      expect(suite.results).toEqual([]);
    });
  });
});
