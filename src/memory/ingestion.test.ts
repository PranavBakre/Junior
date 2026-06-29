import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
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

      // The live capture path writes raw source records ONLY (v3) — the Slack
      // message and the routing decision both land in memory_source_record.
      const db = (store as unknown as { db: Database }).db;
      const slackRows = db
        .query<{ kind: string; body: string }, []>(
          "SELECT kind, body FROM memory_source_record WHERE kind = 'routing_decision' OR kind = 'slack_message'",
        )
        .all();
      expect(slackRows.some((row) => row.body.includes("dashboard CSS"))).toBe(true);
      expect(slackRows.some((row) => row.body.includes("Selected frontend"))).toBe(true);
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

      // Runner results are captured as raw source records (kind 'runner_output').
      const db = (store as unknown as { db: Database }).db;
      const runnerRows = db
        .query<{ body: string }, []>(
          "SELECT body FROM memory_source_record WHERE kind = 'runner_output'",
        )
        .all();
      expect(runnerRows.some((row) => row.body.includes("Implemented endpoint"))).toBe(true);
      expect(runnerRows.some((row) => row.body.includes("boom"))).toBe(true);
    } finally {
      store.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
