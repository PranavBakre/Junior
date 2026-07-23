import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import path from "node:path";
import {
  recordSuccessfulExecution,
  recordProcedureMemoryLink,
  checkPromotionThreshold,
  deduplicateAgainstExisting,
  listCandidates,
  getCandidate,
  updateCandidateStatus,
  archiveStaleCandidate,
  findStaleCandidates,
  clearCandidatesForTests,
} from "./promotion.ts";
import { AGENT_IDENTITIES, registerAgentIdentity } from "../support/agents.ts";
import { clearRegistryForTests, loadRunbookRegistryFromDir } from "./registry.ts";
import type { RunbookRunEvidence } from "./evidence.ts";
import type { PromotionCandidate } from "./types.ts";

const FIXTURE_DIR = path.join(import.meta.dir, "__fixtures__");
const MS_PER_DAY = 86_400_000;

function makeEvidence(overrides?: Partial<RunbookRunEvidence>): RunbookRunEvidence {
  return {
    runId: "run-" + Math.random().toString(36).slice(2, 8),
    runbookName: "test-runbook",
    contentDigest: "abc123",
    ownerAgent: "build",
    risk: "production-write",
    boundInputs: {},
    status: "completed",
    startedAt: Date.now(),
    completedAt: Date.now(),
    intentFingerprint: "fp-test-1",
    ...overrides,
  };
}

function makeCandidate(overrides?: Partial<PromotionCandidate>): PromotionCandidate {
  return {
    fingerprint: "fp-" + Math.random().toString(36).slice(2, 8),
    proposedKind: "runbook",
    normalizedIntent: "some procedure",
    ownerAgent: "build",
    occurrenceCount: 1,
    successfulCount: 1,
    firstSeenAt: Date.now(),
    lastSeenAt: Date.now(),
    evidenceRefs: [],
    procedureMemoryIds: [],
    status: "tracking",
    risk: null,
    capabilities: [],
    ...overrides,
  };
}

describe("runbook promotion", () => {
  beforeEach(async () => {
    registerAgentIdentity("db-executioner", {
      username: "DB Executioner",
      iconEmoji: ":database:",
    });
    clearCandidatesForTests();
    clearRegistryForTests();
    await loadRunbookRegistryFromDir(FIXTURE_DIR, "private");
  });

  afterEach(() => {
    delete AGENT_IDENTITIES["db-executioner"];
    clearCandidatesForTests();
    clearRegistryForTests();
  });

  describe("recordSuccessfulExecution", () => {
    it("first execution creates a tracking entry", () => {
      const evidence = makeEvidence({ intentFingerprint: "fp-create-1" });
      recordSuccessfulExecution(evidence);

      const candidate = getCandidate("fp-create-1");
      expect(candidate).toBeDefined();
      expect(candidate!.occurrenceCount).toBe(1);
      expect(candidate!.status).toBe("tracking");
      expect(candidate!.evidenceRefs).toContain(evidence.runId);
    });

    it("second execution increments count and links evidence", () => {
      const fp = "fp-increment-1";
      const ev1 = makeEvidence({ intentFingerprint: fp, runId: "run-first" });
      const ev2 = makeEvidence({ intentFingerprint: fp, runId: "run-second" });

      recordSuccessfulExecution(ev1);
      recordSuccessfulExecution(ev2);

      const candidate = getCandidate(fp);
      expect(candidate).toBeDefined();
      expect(candidate!.occurrenceCount).toBe(2);
      expect(candidate!.evidenceRefs).toContain("run-first");
      expect(candidate!.evidenceRefs).toContain("run-second");
      expect(candidate!.evidenceRefs).toHaveLength(2);
    });
  });

  describe("checkPromotionThreshold", () => {
    it("third successful execution triggers shouldPropose", () => {
      const fp = "fp-threshold-3";
      for (let i = 0; i < 3; i++) {
        recordSuccessfulExecution(
          makeEvidence({ intentFingerprint: fp, status: "completed" }),
        );
      }

      const result = checkPromotionThreshold(fp);
      expect(result.shouldPropose).toBe(true);
      expect(result.candidate).toBeDefined();
      expect(result.candidate!.successfulCount).toBe(3);
    });

    it("sub-threshold does not propose", () => {
      const fp = "fp-threshold-2";
      for (let i = 0; i < 2; i++) {
        recordSuccessfulExecution(
          makeEvidence({ intentFingerprint: fp, status: "completed" }),
        );
      }

      const result = checkPromotionThreshold(fp);
      expect(result.shouldPropose).toBe(false);
      expect(result.reason).toContain("2/3");
    });

    it("explicit human request bypasses count threshold", () => {
      const fp = "fp-explicit-1";
      recordSuccessfulExecution(
        makeEvidence({ intentFingerprint: fp, status: "completed" }),
      );

      const result = checkPromotionThreshold(fp, { explicitRequest: true });
      expect(result.shouldPropose).toBe(true);
      expect(result.reason).toContain("explicit human request");
    });

    it("already-proposed candidate does not re-propose", () => {
      const fp = "fp-proposed-1";
      for (let i = 0; i < 3; i++) {
        recordSuccessfulExecution(
          makeEvidence({ intentFingerprint: fp, status: "completed" }),
        );
      }

      updateCandidateStatus(fp, "proposed");

      const result = checkPromotionThreshold(fp);
      expect(result.shouldPropose).toBe(false);
      expect(result.reason).toContain("proposed");
    });

    it("returns no candidate for unknown fingerprint", () => {
      const result = checkPromotionThreshold("fp-nonexistent");
      expect(result.shouldPropose).toBe(false);
      expect(result.reason).toContain("no candidate found");
      expect(result.candidate).toBeNull();
    });
  });

  describe("deduplicateAgainstExisting", () => {
    it("detects duplicate against existing runbook", () => {
      // normalizedIntent tokens must overlap > 0.5 Jaccard with fixture
      // transfer-ai-roadmaps. Fixture has name "transfer-ai-roadmaps",
      // description "Transfer every AI roadmap owned by one user to another user.",
      // tags ["database", "ai-roadmaps"].
      const candidate = makeCandidate({
        normalizedIntent:
          "transfer every ai roadmaps from one user to another user",
      });

      const result = deduplicateAgainstExisting(candidate);
      expect(result.isDuplicate).toBe(true);
      expect(result.existingName).toBe("transfer-ai-roadmaps");
    });

    it("no match for unrelated intent", () => {
      const candidate = makeCandidate({
        normalizedIntent: "cooking recipes",
      });

      const result = deduplicateAgainstExisting(candidate);
      expect(result.isDuplicate).toBe(false);
      expect(result.existingName).toBeUndefined();
    });
  });

  describe("findStaleCandidates", () => {
    it("finds candidate older than 90 days", () => {
      const fp = "fp-stale-91";
      const now = Date.now();
      const ninetyOneDaysAgo = now - 91 * MS_PER_DAY;

      recordSuccessfulExecution(
        makeEvidence({
          intentFingerprint: fp,
          startedAt: ninetyOneDaysAgo,
          completedAt: ninetyOneDaysAgo,
        }),
      );

      const stale = findStaleCandidates({ now });
      expect(stale.length).toBeGreaterThanOrEqual(1);
      expect(stale.some((c) => c.fingerprint === fp)).toBe(true);
    });

    it("does not find candidate only 30 days old", () => {
      const fp = "fp-recent-30";
      const now = Date.now();
      const thirtyDaysAgo = now - 30 * MS_PER_DAY;

      recordSuccessfulExecution(
        makeEvidence({
          intentFingerprint: fp,
          startedAt: thirtyDaysAgo,
          completedAt: thirtyDaysAgo,
        }),
      );

      const stale = findStaleCandidates({ now });
      expect(stale.some((c) => c.fingerprint === fp)).toBe(false);
    });

    it("excludes archived candidates", () => {
      const fp = "fp-archived-stale";
      const now = Date.now();
      const ninetyOneDaysAgo = now - 91 * MS_PER_DAY;

      recordSuccessfulExecution(
        makeEvidence({
          intentFingerprint: fp,
          startedAt: ninetyOneDaysAgo,
          completedAt: ninetyOneDaysAgo,
        }),
      );
      archiveStaleCandidate(fp, "test archival");

      const stale = findStaleCandidates({ now });
      expect(stale.some((c) => c.fingerprint === fp)).toBe(false);
    });
  });

  describe("recordProcedureMemoryLink", () => {
    it("links a memory ID to a candidate", () => {
      const fp = "fp-memory-1";
      recordSuccessfulExecution(makeEvidence({ intentFingerprint: fp }));

      recordProcedureMemoryLink(fp, "mem-abc-123");

      const candidate = getCandidate(fp);
      expect(candidate!.procedureMemoryIds).toContain("mem-abc-123");
    });

    it("deduplicates same memory ID", () => {
      const fp = "fp-memory-dedup";
      recordSuccessfulExecution(makeEvidence({ intentFingerprint: fp }));

      recordProcedureMemoryLink(fp, "mem-dup-1");
      recordProcedureMemoryLink(fp, "mem-dup-1");

      const candidate = getCandidate(fp);
      expect(candidate!.procedureMemoryIds).toHaveLength(1);
    });

    it("no-ops for unknown fingerprint", () => {
      // Should not throw
      recordProcedureMemoryLink("fp-nonexistent", "mem-xyz");
    });
  });

  describe("updateCandidateStatus", () => {
    it("transitions tracking → proposed → accepted", () => {
      const fp = "fp-status-transitions";
      recordSuccessfulExecution(makeEvidence({ intentFingerprint: fp }));

      expect(getCandidate(fp)!.status).toBe("tracking");

      expect(updateCandidateStatus(fp, "proposed")).toBe(true);
      expect(getCandidate(fp)!.status).toBe("proposed");

      expect(updateCandidateStatus(fp, "accepted")).toBe(true);
      expect(getCandidate(fp)!.status).toBe("accepted");
    });

    it("returns false for unknown fingerprint", () => {
      expect(updateCandidateStatus("fp-nonexistent", "proposed")).toBe(false);
    });
  });

  describe("archiveStaleCandidate", () => {
    it("marks candidate as archived", () => {
      const fp = "fp-archive-1";
      recordSuccessfulExecution(makeEvidence({ intentFingerprint: fp }));

      expect(archiveStaleCandidate(fp, "too old")).toBe(true);
      expect(getCandidate(fp)!.status).toBe("archived");
    });

    it("returns false for unknown fingerprint", () => {
      expect(archiveStaleCandidate("fp-nonexistent", "reason")).toBe(false);
    });
  });

  describe("listCandidates", () => {
    it("returns all candidates when no filter", () => {
      recordSuccessfulExecution(makeEvidence({ intentFingerprint: "fp-list-a" }));
      recordSuccessfulExecution(makeEvidence({ intentFingerprint: "fp-list-b" }));

      const all = listCandidates();
      expect(all).toHaveLength(2);
    });

    it("filters by status", () => {
      recordSuccessfulExecution(makeEvidence({ intentFingerprint: "fp-filter-tracking" }));
      recordSuccessfulExecution(makeEvidence({ intentFingerprint: "fp-filter-proposed" }));
      updateCandidateStatus("fp-filter-proposed", "proposed");

      const tracking = listCandidates({ status: "tracking" });
      expect(tracking).toHaveLength(1);
      expect(tracking[0].fingerprint).toBe("fp-filter-tracking");

      const proposed = listCandidates({ status: "proposed" });
      expect(proposed).toHaveLength(1);
      expect(proposed[0].fingerprint).toBe("fp-filter-proposed");
    });

    it("filters by minOccurrences", () => {
      const fpOnce = "fp-min-once";
      const fpThrice = "fp-min-thrice";

      recordSuccessfulExecution(makeEvidence({ intentFingerprint: fpOnce }));
      for (let i = 0; i < 3; i++) {
        recordSuccessfulExecution(makeEvidence({ intentFingerprint: fpThrice }));
      }

      const result = listCandidates({ minOccurrences: 3 });
      expect(result).toHaveLength(1);
      expect(result[0].fingerprint).toBe(fpThrice);
      expect(result[0].occurrenceCount).toBe(3);
    });
  });

  describe("clearCandidatesForTests", () => {
    it("empties all candidates", () => {
      recordSuccessfulExecution(makeEvidence({ intentFingerprint: "fp-clear-1" }));
      recordSuccessfulExecution(makeEvidence({ intentFingerprint: "fp-clear-2" }));
      expect(listCandidates()).toHaveLength(2);

      clearCandidatesForTests();
      expect(listCandidates()).toHaveLength(0);
      expect(getCandidate("fp-clear-1")).toBeUndefined();
    });
  });
});
