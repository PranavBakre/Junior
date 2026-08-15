import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUDIT_RETENTION_MS } from "../../lifecycle/cleanup.ts";
import { SqliteDashboardAuditStore } from "./sqlite.ts";

describe("SqliteDashboardAuditStore", () => {
  let tmpDir: string;
  let store: SqliteDashboardAuditStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "junior-audit-"));
    store = new SqliteDashboardAuditStore(join(tmpDir, "sessions.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("records and lists newest first", async () => {
    await store.record({
      at: 100,
      actor: "dashboard-operator",
      action: "session.continue",
      targetType: "session",
      targetId: "thread-1",
      request: { prompt: "hello" },
      result: "ok",
    });
    await store.record({
      at: 200,
      actor: "U123",
      action: "session.stop",
      targetType: "session",
      targetId: "thread-1",
      result: "ok",
    });

    const rows = await store.list({ targetType: "session" });
    expect(rows.map((row) => row.action)).toEqual([
      "session.stop",
      "session.continue",
    ]);
    expect(rows[1]?.request).toEqual({ prompt: "hello" });
  });

  it("deletes rows older than the retention cutoff", async () => {
    const now = 1_800_000_000_000;
    await store.record({
      at: now - AUDIT_RETENTION_MS - 5,
      actor: "dashboard-operator",
      action: "workflow.run",
      targetType: "workflow",
      targetId: "worklog",
      result: "ok",
    });
    await store.record({
      at: now - 1_000,
      actor: "dashboard-operator",
      action: "session.stop",
      targetType: "session",
      targetId: "thread-1",
      result: "ok",
    });

    expect(await store.deleteOlderThan(now - AUDIT_RETENTION_MS)).toBe(1);
    const remaining = await store.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.action).toBe("session.stop");
  });
});
