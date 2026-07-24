import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import path from "node:path";
import {
  AGENT_IDENTITIES,
  registerAgentIdentity,
} from "../support/agents.ts";
import {
  clearRegistryForTests,
  getRunbook,
  loadRunbookRegistryFromDir,
} from "./registry.ts";
import {
  createRunEvidence,
  createIntentFingerprint,
  buildProcedureFallback,
} from "./evidence.ts";
import type { RunbookDefinition } from "./types.ts";

const FIXTURE_DIR = path.join(import.meta.dir, "__fixtures__");

describe("runbook evidence", () => {
  let runbook: RunbookDefinition;

  beforeEach(async () => {
    registerAgentIdentity("db-executioner", {
      username: "DB Executioner",
      iconEmoji: ":database:",
    });
    clearRegistryForTests();
    await loadRunbookRegistryFromDir(FIXTURE_DIR, "private");
    runbook = getRunbook("transfer-ai-roadmaps")!;
  });

  afterEach(() => {
    delete AGENT_IDENTITIES["db-executioner"];
    clearRegistryForTests();
  });

  describe("createRunEvidence", () => {
    it("returns evidence with correct fields", () => {
      const evidence = createRunEvidence(
        runbook,
        { sourceEmail: "alice@example.com", targetEmail: "bob@example.com" },
        "move all AI roadmaps from one account to another",
        Date.now(),
      );

      expect(evidence.runbookName).toBe("transfer-ai-roadmaps");
      expect(evidence.contentDigest).toBe(runbook.contentDigest);
      expect(evidence.risk).toBe("production-write");
      expect(evidence.status).toBe("selected");
      expect(evidence.ownerAgent).toBe("db-executioner");
    });

    it("has redacted bound inputs (emails masked)", () => {
      const evidence = createRunEvidence(
        runbook,
        { sourceEmail: "alice@example.com", targetEmail: "bob@example.com" },
        "move all AI roadmaps",
        Date.now(),
      );

      expect(evidence.boundInputs.sourceEmail).toBe("a***@example.com");
      expect(evidence.boundInputs.targetEmail).toBe("b***@example.com");
    });

    it("has a non-empty runId", () => {
      const evidence = createRunEvidence(
        runbook,
        { sourceEmail: "alice@example.com" },
        "move all AI roadmaps",
        Date.now(),
      );

      expect(evidence.runId).toBeTruthy();
      expect(evidence.runId.length).toBeGreaterThan(0);
    });

    it("has a non-empty intentFingerprint", () => {
      const evidence = createRunEvidence(
        runbook,
        { sourceEmail: "alice@example.com" },
        "move all AI roadmaps",
        Date.now(),
      );

      expect(evidence.intentFingerprint).toBeTruthy();
      expect(evidence.intentFingerprint.length).toBeGreaterThan(0);
    });
  });

  describe("createIntentFingerprint", () => {
    it("is stable for the same request and runbook", () => {
      const fp1 = createIntentFingerprint(
        "move all AI roadmaps from one account to another",
        runbook,
      );
      const fp2 = createIntentFingerprint(
        "move all AI roadmaps from one account to another",
        runbook,
      );
      expect(fp1).toBe(fp2);
    });

    it("differs for different requests", () => {
      const fp1 = createIntentFingerprint(
        "move all AI roadmaps from one account to another",
        runbook,
      );
      const fp2 = createIntentFingerprint(
        "transfer roadmaps from staging to production",
        runbook,
      );
      expect(fp1).not.toBe(fp2);
    });

    it("does NOT contain raw emails in the hex output", () => {
      const fp = createIntentFingerprint(
        "move AI roadmaps from user@example.com to other@test.com",
        runbook,
      );
      expect(fp).not.toContain("user@example.com");
      expect(fp).not.toContain("other@test.com");
      // Should be a hex string
      expect(fp).toMatch(/^[0-9a-f]+$/);
    });

    it("does NOT contain raw objectIds in the hex output", () => {
      const fp = createIntentFingerprint(
        "move AI roadmaps for 507f1f77bcf86cd799439011",
        runbook,
      );
      expect(fp).not.toContain("507f1f77bcf86cd799439011");
      expect(fp).toMatch(/^[0-9a-f]+$/);
    });
  });

  describe("buildProcedureFallback", () => {
    it("returns a lowercase normalized query", () => {
      const fallback = buildProcedureFallback("Move ALL Roadmaps NOW!");
      expect(fallback.query).toBe("move all roadmaps now");
    });

    it("includes the warning about procedure memory", () => {
      const fallback = buildProcedureFallback("anything");
      expect(fallback.warning).toContain("procedure memory");
      expect(fallback.warning.length).toBeGreaterThan(0);
    });
  });
});
