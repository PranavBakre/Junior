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
});
