import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "bun:test";
import { SqliteWorkflowStore } from "./store.ts";
import type { WorkflowRun } from "./types.ts";

describe("SqliteWorkflowStore workflow provenance", () => {
  it("round-trips the verified default-branch commit on a run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "junior-workflow-store-"));
    const store = new SqliteWorkflowStore(join(dir, "runs.db"));
    try {
      const run: WorkflowRun = {
        id: "run-1",
        workflowName: "worklog",
        workflowVersionHash: "version-hash",
        sourcePath: "workflows/worklog.workflow.md",
        verifiedCommitSha: "0123456789012345678901234567890123456789",
        reason: "manual",
        actorSlackUserId: "U123ABC",
        status: "success",
        startedAt: 1,
        finishedAt: 2,
        artifactPath: "data/workflow-runs/worklog/run-1.md",
        providerSessionId: null,
        slackChannel: null,
        slackThreadTs: null,
        error: null,
      };
      await store.createRun(run);
      expect((await store.getRun(run.id))?.verifiedCommitSha).toBe(run.verifiedCommitSha);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
