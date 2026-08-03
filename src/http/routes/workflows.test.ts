import { describe, expect, test } from "bun:test";
import { workflowDisplayStatus } from "./workflows.ts";

describe("workflowDisplayStatus", () => {
  test("shows an in-progress run ahead of scheduler state", () => {
    expect(workflowDisplayStatus(true, "active", [{ status: "running" }])).toBe("running");
  });

  test("uses persisted scheduler state when no run is in progress", () => {
    expect(workflowDisplayStatus(true, "stopped", [{ status: "failed" }])).toBe("stopped");
    expect(workflowDisplayStatus(true, "invalid", [])).toBe("invalid");
  });

  test("falls back to the file-level enabled state", () => {
    expect(workflowDisplayStatus(true, undefined, [])).toBe("active");
    expect(workflowDisplayStatus(false, undefined, [])).toBe("stopped");
  });
});
