import { describe, expect, it } from "bun:test";
import { InMemoryDashboardAuditStore } from "../audit/memory.ts";
import { handleAudit } from "./audit.ts";

describe("handleAudit", () => {
  it("lists seeded rows newest first", async () => {
    const store = new InMemoryDashboardAuditStore();
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
      actor: "dashboard-operator",
      action: "session.stop",
      targetType: "session",
      targetId: "thread-1",
      result: "ok",
    });
    await store.record({
      at: 150,
      actor: "dashboard-operator",
      action: "workflow.run",
      targetType: "workflow",
      targetId: "worklog",
      result: "ok",
    });

    const response = await handleAudit(store, new URLSearchParams());
    expect(response.status).toBe(200);
    const body = await response.json() as {
      audit: Array<{ action: string; at: number }>;
    };
    expect(body.audit.map((row) => row.action)).toEqual([
      "session.stop",
      "workflow.run",
      "session.continue",
    ]);
  });

  it("filters by action and target type", async () => {
    const store = new InMemoryDashboardAuditStore();
    await store.record({
      at: 1,
      actor: "dashboard-operator",
      action: "session.continue",
      targetType: "session",
      targetId: "thread-1",
      result: "ok",
    });
    await store.record({
      at: 2,
      actor: "dashboard-operator",
      action: "workflow.run",
      targetType: "workflow",
      targetId: "worklog",
      result: "ok",
    });

    const response = await handleAudit(
      store,
      new URLSearchParams("action=workflow.run&targetType=workflow"),
    );
    const body = await response.json() as { audit: Array<{ action: string }> };
    expect(body.audit).toEqual([
      expect.objectContaining({ action: "workflow.run" }),
    ]);
  });
});
