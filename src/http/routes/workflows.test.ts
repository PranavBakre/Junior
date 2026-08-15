import { describe, expect, test } from "bun:test";
import type { WorkflowRegistry } from "../../workflows/registry.ts";
import type { WorkflowStore } from "../../workflows/store.ts";
import type { WorkflowDefinition, WorkflowRun } from "../../workflows/types.ts";
import { handleWorkflows, workflowDisplayStatus } from "./workflows.ts";

describe("workflowDisplayStatus", () => {
  test("shows an in-progress run ahead of scheduler state", () => {
    expect(workflowDisplayStatus(true, "active", true)).toBe("running");
  });

  test("uses persisted scheduler state when no run is in progress", () => {
    expect(workflowDisplayStatus(true, "stopped", false)).toBe("stopped");
    expect(workflowDisplayStatus(true, "invalid", false)).toBe("invalid");
  });

  test("falls back to the file-level enabled state", () => {
    expect(workflowDisplayStatus(true, undefined, false)).toBe("active");
    expect(workflowDisplayStatus(false, undefined, false)).toBe("stopped");
  });

  test("does not treat a stale persisted run as live activity", async () => {
    const definition = workflowDefinition();
    const staleRun = workflowRun("running");
    const registry = {
      all: () => [definition],
      getErrors: () => [],
    } as unknown as WorkflowRegistry;
    const store = {
      listStates: async () => [{
        name: definition.name,
        status: "active",
        activeVersionHash: definition.versionHash,
        sourcePath: definition.sourcePath,
        lastLoadedAt: 1,
        nextRunAt: null,
        lastRunAt: 1,
        lastRunStatus: null,
        lastError: null,
      }],
      listRuns: async () => [staleRun],
    } as unknown as WorkflowStore;

    const response = await handleWorkflows(registry, store, { isRunning: () => false });
    const body = await response.json() as {
      workflows: Array<{
        displayStatus: string;
        nativeHandler: string | null;
        sourceMarkdown: boolean;
        runs: Array<{ status: string }>;
      }>;
    };

    expect(body.workflows[0]?.runs[0]?.status).toBe("running");
    expect(body.workflows[0]?.displayStatus).toBe("active");
    expect(body.workflows[0]?.nativeHandler).toBeNull();
    expect(body.workflows[0]?.sourceMarkdown).toBe(false);
  });

  test("includes nativeHandler on the list projection", async () => {
    const definition = workflowDefinition();
    definition.nativeHandler = "memory-dedup-sweep";
    const registry = {
      all: () => [definition],
      getErrors: () => [],
    } as unknown as WorkflowRegistry;
    const store = {
      listStates: async () => [],
      listRuns: async () => [],
    } as unknown as WorkflowStore;

    const response = await handleWorkflows(registry, store, { isRunning: () => false });
    const body = await response.json() as {
      workflows: Array<{ nativeHandler: string | null }>;
    };
    expect(body.workflows[0]?.nativeHandler).toBe("memory-dedup-sweep");
  });
});

function workflowDefinition(): WorkflowDefinition {
  return {
    name: "worklog",
    enabled: true,
    ownerSlackUserIds: [],
    triggers: [{ type: "command", command: "worklog" }],
    outputs: [{ type: "docs", path: "data/workflow-runs/worklog" }],
    permissions: { tools: ["docs.write"] },
    concurrency: "skip",
    prompt: "Summarize work.",
    versionHash: "1234567890abcdef",
    sourcePath: "workflows/worklog.workflow.md",
    sourceRoot: "public",
  };
}

function workflowRun(status: WorkflowRun["status"]): WorkflowRun {
  return {
    id: "run-1",
    workflowName: "worklog",
    workflowVersionHash: "1234567890abcdef",
    sourcePath: "workflows/worklog.workflow.md",
    reason: "manual",
    actorSlackUserId: null,
    status,
    startedAt: 1,
    finishedAt: null,
    artifactPath: "data/workflow-runs/worklog/run-1.md",
    providerSessionId: null,
    slackChannel: null,
    slackThreadTs: null,
    error: null,
  };
}
