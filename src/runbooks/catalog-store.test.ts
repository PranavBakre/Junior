import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  CatalogStore,
  type CatalogEntry,
  type DefinitionRun,
  type DefinitionEvaluation,
} from "./catalog-store.ts";

function makeCatalogEntry(overrides?: Partial<CatalogEntry>): CatalogEntry {
  return {
    kind: "runbook",
    name: "test-runbook",
    repo: "junior-private-agents",
    path: "agents-org/runbooks/test-runbook.runbook.md",
    commitSha: "abc123def456",
    contentDigest: "digest-aaa",
    schemaVersion: 1,
    enabled: true,
    loadedAt: Date.now(),
    validationStatus: "valid",
    validationErrors: null,
    ...overrides,
  };
}

function makeRun(overrides?: Partial<DefinitionRun>): DefinitionRun {
  return {
    id: "run-" + Math.random().toString(36).slice(2, 8),
    kind: "runbook",
    name: "test-runbook",
    versionDigest: "digest-1",
    ownerAgent: "build",
    intentFingerprint: "fp-1",
    risk: "production-write",
    status: "completed",
    startedAt: Date.now(),
    completedAt: Date.now(),
    approvalRef: null,
    evidenceRefs: null,
    ...overrides,
  };
}

function makeEvaluation(
  overrides?: Partial<DefinitionEvaluation>,
): DefinitionEvaluation {
  return {
    id: "eval-" + Math.random().toString(36).slice(2, 8),
    kind: "runbook",
    name: "test-runbook",
    versionDigest: "digest-1",
    fixture: "move AI roadmaps from A to B",
    expectedRoute: true,
    actualRoute: true,
    passed: true,
    evaluatedAt: Date.now(),
    ...overrides,
  };
}

describe("CatalogStore", () => {
  let store: CatalogStore;

  beforeEach(() => {
    store = new CatalogStore(":memory:");
  });

  afterEach(() => {
    store.close();
  });

  describe("upsert and get", () => {
    it("inserts an entry and retrieves it by kind+name", () => {
      const entry = makeCatalogEntry();
      store.upsertCatalogEntry(entry);

      const result = store.getCatalogEntry("runbook", "test-runbook");
      expect(result).not.toBeNull();
      expect(result!.kind).toBe("runbook");
      expect(result!.name).toBe("test-runbook");
      expect(result!.repo).toBe("junior-private-agents");
      expect(result!.path).toBe("agents-org/runbooks/test-runbook.runbook.md");
      expect(result!.commitSha).toBe("abc123def456");
      expect(result!.contentDigest).toBe("digest-aaa");
      expect(result!.schemaVersion).toBe(1);
      expect(result!.enabled).toBe(true);
      expect(result!.loadedAt).toBe(entry.loadedAt);
      expect(result!.validationStatus).toBe("valid");
      expect(result!.validationErrors).toBeNull();
    });
  });

  describe("upsert overwrites", () => {
    it("updates contentDigest on second upsert for same kind+name", () => {
      store.upsertCatalogEntry(
        makeCatalogEntry({ contentDigest: "old-digest" }),
      );
      store.upsertCatalogEntry(
        makeCatalogEntry({ contentDigest: "new-digest" }),
      );

      const result = store.getCatalogEntry("runbook", "test-runbook");
      expect(result).not.toBeNull();
      expect(result!.contentDigest).toBe("new-digest");
    });
  });

  describe("get returns null for unknown", () => {
    it("returns null when name does not exist", () => {
      const result = store.getCatalogEntry("runbook", "nonexistent-runbook");
      expect(result).toBeNull();
    });
  });

  describe("listCatalogEntries", () => {
    it("returns all entries sorted by name", () => {
      store.upsertCatalogEntry(makeCatalogEntry({ name: "zulu-runbook" }));
      store.upsertCatalogEntry(makeCatalogEntry({ name: "alpha-runbook" }));

      const entries = store.listCatalogEntries();
      expect(entries.length).toBe(2);
      expect(entries[0].name).toBe("alpha-runbook");
      expect(entries[1].name).toBe("zulu-runbook");
    });
  });

  describe("listCatalogEntries filtered by kind", () => {
    it("returns only entries matching the requested kind", () => {
      store.upsertCatalogEntry(
        makeCatalogEntry({ kind: "runbook", name: "my-runbook" }),
      );
      store.upsertCatalogEntry(
        makeCatalogEntry({ kind: "agent", name: "my-agent" }),
      );

      const runbooks = store.listCatalogEntries("runbook");
      expect(runbooks.length).toBe(1);
      expect(runbooks[0].name).toBe("my-runbook");
      expect(runbooks[0].kind).toBe("runbook");

      const agents = store.listCatalogEntries("agent");
      expect(agents.length).toBe(1);
      expect(agents[0].name).toBe("my-agent");
      expect(agents[0].kind).toBe("agent");
    });
  });

  describe("deactivateEntry", () => {
    it("sets enabled to false for existing entry", () => {
      store.upsertCatalogEntry(makeCatalogEntry({ enabled: true }));

      const result = store.deactivateEntry("runbook", "test-runbook");
      expect(result).toBe(true);

      const entry = store.getCatalogEntry("runbook", "test-runbook");
      expect(entry).not.toBeNull();
      expect(entry!.enabled).toBe(false);
    });
  });

  describe("deactivateEntry returns false for unknown", () => {
    it("returns false when the entry does not exist", () => {
      const result = store.deactivateEntry("runbook", "ghost-runbook");
      expect(result).toBe(false);
    });
  });

  describe("insertRun", () => {
    it("inserts a run retrievable by getRunsByName", () => {
      const run = makeRun({ id: "run-abc", name: "target-rb" });
      store.insertRun(run);

      const runs = store.getRunsByName("target-rb");
      expect(runs.length).toBe(1);
      expect(runs[0].id).toBe("run-abc");
      expect(runs[0].name).toBe("target-rb");
      expect(runs[0].kind).toBe("runbook");
      expect(runs[0].status).toBe("completed");
    });
  });

  describe("getRunsByName", () => {
    it("returns multiple runs in DESC order by started_at", () => {
      store.insertRun(
        makeRun({ id: "run-older", name: "multi-rb", startedAt: 1000 }),
      );
      store.insertRun(
        makeRun({ id: "run-newer", name: "multi-rb", startedAt: 3000 }),
      );

      const runs = store.getRunsByName("multi-rb");
      expect(runs.length).toBe(2);
      // DESC order: newest first
      expect(runs[0].id).toBe("run-newer");
      expect(runs[1].id).toBe("run-older");
    });
  });

  describe("getRunsByDigest", () => {
    it("filters runs by version digest", () => {
      store.insertRun(makeRun({ id: "r1", versionDigest: "digest-x" }));
      store.insertRun(makeRun({ id: "r2", versionDigest: "digest-y" }));
      store.insertRun(makeRun({ id: "r3", versionDigest: "digest-x" }));

      const filtered = store.getRunsByDigest("digest-x");
      expect(filtered.length).toBe(2);
      const ids = filtered.map((r) => r.id).sort();
      expect(ids).toEqual(["r1", "r3"]);

      const other = store.getRunsByDigest("digest-y");
      expect(other.length).toBe(1);
      expect(other[0].id).toBe("r2");
    });
  });

  describe("updateRunStatus", () => {
    it("updates status and completedAt on an existing run", () => {
      store.insertRun(
        makeRun({
          id: "run-pending",
          status: "pending",
          completedAt: null,
        }),
      );

      const now = Date.now();
      store.updateRunStatus("run-pending", "completed", now);

      const runs = store.getRunsByName("test-runbook");
      expect(runs.length).toBe(1);
      expect(runs[0].status).toBe("completed");
    });
  });

  describe("insertEvaluation", () => {
    it("inserts an evaluation retrievable by getEvaluationsByName", () => {
      const evaluation = makeEvaluation({ id: "eval-1", name: "eval-rb" });
      store.insertEvaluation(evaluation);

      const evals = store.getEvaluationsByName("eval-rb");
      expect(evals.length).toBe(1);
      expect(evals[0].id).toBe("eval-1");
      expect(evals[0].kind).toBe("runbook");
      expect(evals[0].name).toBe("eval-rb");
    });
  });

  describe("getEvaluationsByName", () => {
    it("returns evaluations with correct boolean fields", () => {
      store.insertEvaluation(
        makeEvaluation({
          name: "bool-rb",
          expectedRoute: true,
          actualRoute: false,
          passed: false,
        }),
      );
      store.insertEvaluation(
        makeEvaluation({
          name: "bool-rb",
          expectedRoute: false,
          actualRoute: false,
          passed: true,
        }),
      );

      const evals = store.getEvaluationsByName("bool-rb");
      expect(evals.length).toBe(2);

      // Verify boolean conversion from SQLite integers
      for (const ev of evals) {
        expect(typeof ev.expectedRoute).toBe("boolean");
        expect(typeof ev.actualRoute).toBe("boolean");
        expect(typeof ev.passed).toBe("boolean");
      }

      // At least one has expectedRoute=true, actualRoute=false, passed=false
      const failing = evals.find((e) => e.passed === false);
      expect(failing).toBeDefined();
      expect(failing!.expectedRoute).toBe(true);
      expect(failing!.actualRoute).toBe(false);

      // At least one has expectedRoute=false, actualRoute=false, passed=true
      const passing = evals.find((e) => e.passed === true);
      expect(passing).toBeDefined();
      expect(passing!.expectedRoute).toBe(false);
      expect(passing!.actualRoute).toBe(false);
    });
  });

  describe("close", () => {
    it("does not throw on close", () => {
      expect(() => store.close()).not.toThrow();
    });
  });
});
