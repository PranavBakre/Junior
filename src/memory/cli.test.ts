import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMemoryCli } from "./cli.ts";
import { SqliteMemoryStore } from "./sqlite.ts";

describe("memory CLI", () => {
  it("recalls memories from the configured db", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "junior-memory-cli-"));
    const dbPath = join(tmpDir, "memory.db");
    const store = new SqliteMemoryStore(dbPath);
    try {
      const now = Date.now();
      await store.appendSourceRecord({ id: "source-1", kind: "slack_message", body: "dashboard alias", createdAt: now });
      await store.upsertEvent({ id: "event-1", sourceRecordId: "source-1", threadId: "T1", body: "dashboard means gx-admin-client", createdAt: now });
      const output = await runMemoryCli(["recall", "--db", dbPath, "--query", "dashboard", "--json"]);
      const parsed = JSON.parse(output) as { results: Array<{ id: string }> };
      expect(parsed.results.map((result) => result.id)).toContain("event-1");
    } finally {
      store.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("runs consolidation from the configured db", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "junior-memory-cli-"));
    const dbPath = join(tmpDir, "memory.db");
    const store = new SqliteMemoryStore(dbPath);
    try {
      await store.logCorrection({ eventId: "event-a", field: "routing_fact", correctValue: "dashboard means gx-admin-client", correctedBy: "user", createdAt: Date.now() });
      await store.logCorrection({ eventId: "event-b", field: "routing_fact", correctValue: "dashboard means gx-admin-client", correctedBy: "user", createdAt: Date.now() });
      const output = await runMemoryCli(["consolidate", "--db", dbPath, "--json"]);
      const parsed = JSON.parse(output) as { promotedMemoryIds: string[] };
      expect(parsed.promotedMemoryIds).toContain("routing_memory_dashboard_means_gx-admin-client");
    } finally {
      store.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("accepts, rejects, and lists rules from the configured db", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "junior-memory-cli-"));
    const dbPath = join(tmpDir, "memory.db");
    const store = new SqliteMemoryStore(dbPath);
    try {
      await store.proposeRule({
        id: "rule_tag_test",
        status: "draft",
        domain: "tag",
        ruleText: "tag(Event, test) :- test.",
        positiveExampleIds: [],
        negativeExampleIds: [],
        createdAt: Date.now(),
      });

      const acceptOut = await runMemoryCli(["accept-rule", "--db", dbPath, "--id", "rule_tag_test", "--json"]);
      expect(JSON.parse(acceptOut)).toEqual({ accepted: true, id: "rule_tag_test" });

      const listOut = await runMemoryCli(["accepted-rules", "--db", dbPath, "--json"]);
      const list = JSON.parse(listOut) as { rules: Array<{ id: string }> };
      expect(list.rules.map((rule) => rule.id)).toContain("rule_tag_test");

      const rejectOut = await runMemoryCli(["reject-rule", "--db", dbPath, "--id", "rule_tag_test", "--json"]);
      expect(JSON.parse(rejectOut)).toEqual({ rejected: true, id: "rule_tag_test" });

      const after = await runMemoryCli(["accepted-rules", "--db", dbPath, "--json"]);
      expect(JSON.parse(after)).toEqual({ rules: [] });
    } finally {
      store.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("updates a lesson body and appends tags", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "junior-memory-cli-"));
    const dbPath = join(tmpDir, "memory.db");
    const store = new SqliteMemoryStore(dbPath);
    try {
      const now = Date.now();
      // Seed: create a lesson with original tags, plus a source event for provenance
      await store.appendSourceRecord({ id: "src-upd-1", kind: "manual_correction", body: "source", createdAt: now });
      await store.upsertLesson({
        id: "lesson-upd", title: "Original", body: "Original body",
        appliesWhen: "always", importance: 0.5, createdAt: now,
        tags: ["memory", "recall"],
        sourceIds: ["src-upd-1"],
      });

      // Update: change body, add a tag, add a source
      await store.updateLesson("lesson-upd", {
        body: "Updated body with new content",
        addTags: ["performance"],
        addSourceIds: ["src-upd-2"],
      });

      // Verify through recall: updated body should match
      const results = await store.recall({ query: "Updated body with new", limit: 3 });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].body).toBe("Updated body with new content");

      // Verify original tags still surface the lesson
      const tagResults = await store.recall({ tags: ["memory"], limit: 3 });
      expect(tagResults.map((r) => r.id)).toContain("lesson-upd");
    } finally {
      store.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("updates a fact confidence", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "junior-memory-cli-"));
    const dbPath = join(tmpDir, "memory.db");
    const store = new SqliteMemoryStore(dbPath);
    try {
      const now = Date.now();
      await store.upsertFact({
        id: "fact-upd", kind: "curated_fact", title: "Updatable Fact", body: "dashboard means gx-admin-client",
        confidence: 0.3, importance: 0.5, createdAt: now,
      });

      await store.updateFact("fact-upd", { confidence: 0.9 });

      // Verify fact still surfaces with correct content
      const results = await store.recall({ query: "dashboard", limit: 3 });
      const found = results.find((r) => r.id === "fact-upd");
      expect(found).toBeDefined();
      expect(found!.body).toBe("dashboard means gx-admin-client");
    } finally {
      store.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("merges lessons and the merged node surfaces in recall", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "junior-memory-cli-"));
    const dbPath = join(tmpDir, "memory.db");
    const store = new SqliteMemoryStore(dbPath);
    try {
      const now = Date.now();
      await store.upsertLesson({
        id: "lesson-a", title: "Lesson A", body: "Always use SQLite FTS for search lookups",
        importance: 0.6, createdAt: now, tags: ["search"],
      });
      await store.upsertLesson({
        id: "lesson-b", title: "Lesson B", body: "Avoid vector DBs until needed",
        importance: 0.8, createdAt: now, tags: ["vector"],
      });

      const result = await store.mergeLessons(["lesson-a", "lesson-b"], "Memory Architecture");
      expect(result.sourceIds).toEqual(["lesson-a", "lesson-b"]);
      expect(result.mergedId).toContain("lesson_merged_");

      // The merged lesson should show up in recall for either source's content
      const results = await store.recall({ query: "SQLite FTS search lookups", limit: 3 });
      expect(results.map((r) => r.id)).toContain(result.mergedId);

      // Source lessons should NOT appear in recall for a new query (they're inactive)
      const tagResults = await store.recall({ query: "Avoid vector DBs", limit: 3 });
      const sourceIds = tagResults.map((r) => r.id);
      expect(sourceIds).not.toContain("lesson-a");
      expect(sourceIds).not.toContain("lesson-b");
      // But merged node should appear
      expect(sourceIds).toContain(result.mergedId);
    } finally {
      store.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("merges facts and supersedes sources", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "junior-memory-cli-"));
    const dbPath = join(tmpDir, "memory.db");
    const store = new SqliteMemoryStore(dbPath);
    try {
      const now = Date.now();
      await store.upsertFact({
        id: "fact-x", kind: "routing_memory", title: "Route A", body: "frontend requests go to gx-client-next",
        importance: 0.7, createdAt: now,
      });
      await store.upsertFact({
        id: "fact-y", kind: "curated_fact", title: "Curated B", body: "frontend is gx-client-next",
        importance: 0.5, createdAt: now,
      });

      const result = await store.mergeFacts(["fact-x", "fact-y"], "Frontend routing");
      expect(result.kind).toBe("fact");
      expect(result.mergedId).toContain("fact_merged_");

      // Merged fact should surface for shared content
      const results = await store.recall({ query: "gx-client-next", limit: 3 });
      expect(results.map((r) => r.id)).toContain(result.mergedId);
      // Source facts should be superseded (not in results)
      expect(results.map((r) => r.id)).not.toContain("fact-x");
      expect(results.map((r) => r.id)).not.toContain("fact-y");
    } finally {
      store.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
