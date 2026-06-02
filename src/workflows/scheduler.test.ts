import { describe, expect, it } from "bun:test";
import type { WorkflowExecutor } from "./executor.ts";
import type { WorkflowRegistry } from "./registry.ts";
import { InMemoryWorkflowStore } from "./store.ts";
import { MAX_TIMER_DELAY_MS, nextScheduledRun, timerDelayFor } from "./scheduler.ts";
import type { WorkflowDefinition } from "./types.ts";

describe("nextScheduledRun", () => {
  it("returns the earliest next schedule across triggers", () => {
    const definition: WorkflowDefinition = {
      name: "worklog",
      enabled: true,
      ownerSlackUserIds: ["U123ABC"],
      triggers: [
        { type: "schedule", cron: "0 18 * * 1-5", timezone: "Asia/Kolkata" },
        { type: "schedule", cron: "0 12 * * 1-5", timezone: "Asia/Kolkata" },
      ],
      outputs: [{ type: "docs", path: "data/workflow-runs/worklog" }],
      permissions: { tools: ["docs.write"] },
      concurrency: "skip",
      prompt: "Summarize work.",
      versionHash: "1234567890abcdef",
      sourcePath: "workflows/worklog.workflow.md",
      sourceRoot: "public",
    };

    const next = nextScheduledRun(
      definition,
      new Date("2026-05-21T05:00:00.000Z"),
    );

    expect(next?.toISOString()).toBe("2026-05-21T06:30:00.000Z");
  });
});

describe("timerDelayFor", () => {
  it("clamps timers to the runtime's 32-bit maximum delay", () => {
    expect(timerDelayFor(MAX_TIMER_DELAY_MS + 10_000)).toBe(MAX_TIMER_DELAY_MS);
    expect(timerDelayFor(-1)).toBe(0);
  });
});

describe("WorkflowScheduler", () => {
  it("blocks stopped command triggers but allows manual runs", async () => {
    const definition = workflowDefinition();
    const store = new InMemoryWorkflowStore();
    const registry = {
      get: (name: string) => name === definition.name ? definition : undefined,
      snapshot: () => ({ definitions: new Map([[definition.name, definition]]), errors: [] }),
      onEvent: () => undefined,
    } as unknown as WorkflowRegistry;
    const executor = {
      run: async () => ({
        summary: "ok",
        run: {
          id: "run-1",
          workflowName: definition.name,
          workflowVersionHash: definition.versionHash,
          sourcePath: definition.sourcePath,
          reason: "manual",
          actorSlackUserId: "U123ABC",
          status: "success",
          startedAt: 1,
          finishedAt: 2,
          artifactPath: "data/workflow-runs/worklog/run.md",
          providerSessionId: null,
          slackChannel: null,
          slackThreadTs: null,
          error: null,
        },
      }),
    } as unknown as WorkflowExecutor;
    const { WorkflowScheduler } = await import("./scheduler.ts");
    const scheduler = new WorkflowScheduler({ registry, store, executor });

    await scheduler.reconcile();
    await scheduler.stopWorkflow(definition.name);

    await expect(scheduler.runNow({
      name: definition.name,
      reason: "command",
      actorSlackUserId: "U123ABC",
    })).rejects.toThrow("is stopped");

    await expect(scheduler.runNow({
      name: definition.name,
      reason: "manual",
      actorSlackUserId: "U123ABC",
    })).resolves.toEqual({ summary: "ok", runId: "run-1" });
  });

  it("admits only one concurrent run for concurrency skip workflows", async () => {
    const definition = workflowDefinition();
    const store = new InMemoryWorkflowStore();
    const registry = {
      get: (name: string) => name === definition.name ? definition : undefined,
      snapshot: () => ({ definitions: new Map([[definition.name, definition]]), errors: [] }),
      onEvent: () => undefined,
    } as unknown as WorkflowRegistry;
    let runs = 0;
    let release: () => void = () => undefined;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const executor = {
      run: async () => {
        runs++;
        await blocker;
        return {
          summary: "ok",
          run: {
            id: `run-${runs}`,
            workflowName: definition.name,
            workflowVersionHash: definition.versionHash,
            sourcePath: definition.sourcePath,
            reason: "manual",
            actorSlackUserId: "U123ABC",
            status: "success",
            startedAt: 1,
            finishedAt: 2,
            artifactPath: "data/workflow-runs/worklog/run.md",
            providerSessionId: null,
            slackChannel: null,
            slackThreadTs: null,
            error: null,
          },
        };
      },
    } as unknown as WorkflowExecutor;
    const { WorkflowScheduler } = await import("./scheduler.ts");
    const scheduler = new WorkflowScheduler({ registry, store, executor });

    const first = scheduler.runNow({
      name: definition.name,
      reason: "manual",
      actorSlackUserId: "U123ABC",
    });
    const second = scheduler.runNow({
      name: definition.name,
      reason: "manual",
      actorSlackUserId: "U123ABC",
    });

    await expect(second).resolves.toEqual({
      summary: "Skipped *worklog*: already running.",
      runId: "",
    });
    expect(runs).toBe(1);
    release();
    await expect(first).resolves.toEqual({ summary: "ok", runId: "run-1" });
  });
});

function workflowDefinition(): WorkflowDefinition {
  return {
    name: "worklog",
    enabled: true,
    ownerSlackUserIds: ["U123ABC"],
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
