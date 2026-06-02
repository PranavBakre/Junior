import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "../../memory/sqlite.ts";
import { handleMemoryRecall } from "./memory.ts";

describe("memory HTTP routes", () => {
  it("returns recalled memory results", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "junior-memory-http-"));
    const store = new SqliteMemoryStore(join(tmpDir, "memory.db"));
    try {
      const now = Date.now();
      await store.appendSourceRecord({ id: "source-1", kind: "slack_message", body: "dashboard", createdAt: now });
      await store.upsertEvent({ id: "event-1", sourceRecordId: "source-1", threadId: "T1", body: "dashboard means gx-admin-client", createdAt: now });
      const response = await handleMemoryRecall(store, new URLSearchParams({ query: "dashboard" }));
      expect(response.status).toBe(200);
      const body = (await response.json()) as { results: Array<{ id: string }> };
      expect(body.results.map((result) => result.id)).toContain("event-1");
    } finally {
      store.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
