import { describe, it, expect } from "bun:test";
import { handleLogs } from "./logs.ts";

describe("handleLogs date validation", () => {
  it("rejects path-traversal in ?date= with HTTP 400", async () => {
    const params = new URLSearchParams({ date: "../../../etc/passwd" });
    const res = await handleLogs(params);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("invalid date");
  });

  it("rejects garbage strings", async () => {
    const params = new URLSearchParams({ date: "not-a-date" });
    const res = await handleLogs(params);
    expect(res.status).toBe(400);
  });

  it("rejects partial-match exploits (regex must be anchored)", async () => {
    // If DATE_RE were unanchored, `2024-01-01/../../etc/passwd` would slip through.
    const params = new URLSearchParams({ date: "2024-01-01/../../etc/passwd" });
    const res = await handleLogs(params);
    expect(res.status).toBe(400);
  });

  it("accepts a well-formed YYYY-MM-DD even when the log file is absent", async () => {
    // No log file for an arbitrary date — should return 200 with empty entries,
    // not 400.
    const params = new URLSearchParams({ date: "1999-01-01" });
    const res = await handleLogs(params);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { date: string; entries: unknown[] };
    expect(body.date).toBe("1999-01-01");
    expect(body.entries).toEqual([]);
  });
});
