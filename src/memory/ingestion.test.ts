import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryIngestor } from "./ingestion.ts";
import { SqliteMemoryStore } from "./sqlite.ts";

describe("MemoryIngestor", () => {
  it("captures Slack messages and routing decisions into memory", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "junior-memory-ingest-"));
    const store = new SqliteMemoryStore(join(tmpDir, "memory.db"));
    try {
      const ingestor = new MemoryIngestor(store);
      await ingestor.captureSlackMessage({
        threadId: "T1",
        channel: "C1",
        user: "U1",
        text: "dashboard CSS is wrong",
        ts: "123.456",
        command: null,
      }, { agentName: "frontend", route: "test" });
      await ingestor.captureRoutingDecision({
        threadId: "T1",
        channelId: "C1",
        slackTs: "123.456",
        user: "U1",
        selectedAgent: "frontend",
        reason: "Selected frontend for CSS task.",
        text: "dashboard CSS is wrong",
      });

      const recalled = await store.recall({ query: "dashboard CSS", limit: 5 });
      expect(recalled.some((memory) => memory.body.includes("dashboard CSS"))).toBe(true);
      const routing = await store.recall({ kinds: ["routing_memory"], tags: ["routing_decision"], limit: 5 });
      expect(routing.some((memory) => memory.body.includes("Selected frontend"))).toBe(true);
    } finally {
      store.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("captures runner completions and errors", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "junior-memory-ingest-"));
    const store = new SqliteMemoryStore(join(tmpDir, "memory.db"));
    try {
      const ingestor = new MemoryIngestor(store);
      await ingestor.captureRunnerResult("T1", "build", {
        provider: "opencode",
        sessionId: "ses-1",
        response: "Implemented endpoint",
        events: [],
        exitCode: 0,
        error: null,
      });
      await ingestor.captureRunnerResult("T1", "build", {
        provider: "opencode",
        sessionId: "ses-2",
        response: "",
        events: [],
        exitCode: 1,
        error: "boom",
      });

      const completed = await store.recall({ query: "Implemented endpoint", limit: 5 });
      expect(completed.map((memory) => memory.outcome)).toContain("runner_completed");
      const failed = await store.recall({ query: "boom", limit: 5 });
      expect(failed.map((memory) => memory.outcome)).toContain("runner_error");
    } finally {
      store.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
