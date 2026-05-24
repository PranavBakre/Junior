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
});
