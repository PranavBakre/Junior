import { describe, expect, it } from "bun:test";
import type { WorkflowExecutor } from "./executor.ts";
import type { WorkflowRegistry } from "./registry.ts";
import { WorkflowScheduler } from "./scheduler.ts";
import { InMemoryWorkflowStore } from "./store.ts";
import type { WorkflowDefinition, WorkflowRun } from "./types.ts";

describe("WorkflowScheduler.enqueueManualRun", () => {
  it("returns started only after the run row is durable and before execute finishes", async () => {
    const definition = workflowDefinition();
    const store = new InMemoryWorkflowStore();
    let executeStarted = false;
    let releaseExecute: () => void = () => undefined;
    const executeGate = new Promise<void>((resolve) => {
      releaseExecute = resolve;
    });
    const executor = mockExecutor(store, {
      execute: async (run) => {
        executeStarted = true;
        await executeGate;
        return successResult(run);
      },
    });
    const scheduler = new WorkflowScheduler({
      registry: registryOf(definition),
      store,
      executor,
    });

    const pending = scheduler.enqueueManualRun({ name: definition.name });
    const result = await pending;
    expect(result).toEqual({
      status: "started",
      runId: expect.stringContaining("worklog-") as unknown as string,
      summary: "Started *worklog*.",
    });
    expect(await store.getRun(result.runId)).toMatchObject({
      id: result.runId,
      status: "running",
    });
    expect(executeStarted).toBe(true);
    expect(scheduler.isRunning(definition.name)).toBe(true);

    releaseExecute();
    await waitFor(() => !scheduler.isRunning(definition.name));
  });

  it("skips a second enqueue while a skip-concurrency run is in flight", async () => {
    const definition = workflowDefinition();
    const store = new InMemoryWorkflowStore();
    let releaseExecute: () => void = () => undefined;
    const executeGate = new Promise<void>((resolve) => {
      releaseExecute = resolve;
    });
    const executor = mockExecutor(store, {
      execute: async (run) => {
        await executeGate;
        return successResult(run);
      },
    });
    const scheduler = new WorkflowScheduler({
      registry: registryOf(definition),
      store,
      executor,
    });

    const first = await scheduler.enqueueManualRun({ name: definition.name });
    expect(first.status).toBe("started");

    const second = await scheduler.enqueueManualRun({ name: definition.name });
    expect(second).toEqual({
      status: "skipped",
      runId: "",
      summary: "Skipped *worklog*: already running.",
    });
    expect((await store.getState(definition.name))?.lastRunStatus).toBe("skipped");

    const third = await scheduler.enqueueManualRun({ name: definition.name });
    expect(third.status).toBe("skipped");
    expect(scheduler.isRunning(definition.name)).toBe(true);

    releaseExecute();
    await waitFor(() => !scheduler.isRunning(definition.name));
  });

  it("releases the claim when persistNewRun throws and does not start", async () => {
    const definition = workflowDefinition();
    const store = new InMemoryWorkflowStore();
    const executor = mockExecutor(store, {
      persist: async () => {
        throw new Error("disk full");
      },
    });
    const scheduler = new WorkflowScheduler({
      registry: registryOf(definition),
      store,
      executor,
    });

    await expect(scheduler.enqueueManualRun({ name: definition.name }))
      .rejects.toThrow("disk full");
    expect(scheduler.isRunning(definition.name)).toBe(false);
    expect(scheduler.activeRunCount(definition.name)).toBe(0);
    expect(await store.listRuns(definition.name, 5)).toEqual([]);
  });

  it("writes lastRunStatus=failed when executePersistedRun throws", async () => {
    const definition = workflowDefinition();
    const store = new InMemoryWorkflowStore();
    const executor = mockExecutor(store, {
      execute: async () => {
        throw new Error("runner exploded");
      },
    });
    const scheduler = new WorkflowScheduler({
      registry: registryOf(definition),
      store,
      executor,
    });

    const result = await scheduler.enqueueManualRun({ name: definition.name });
    expect(result.status).toBe("started");
    await waitFor(async () =>
      (await store.getState(definition.name))?.lastRunStatus === "failed"
    );
    expect((await store.getState(definition.name))?.lastError).toBe("runner exploded");
    expect(scheduler.isRunning(definition.name)).toBe(false);
  });

  it("increments activeRunCounts for overlapping parallel runs", async () => {
    const definition = { ...workflowDefinition(), concurrency: "parallel" as const };
    const store = new InMemoryWorkflowStore();
    const releases: Array<() => void> = [];
    const executor = mockExecutor(store, {
      execute: async (run) => {
        await new Promise<void>((resolve) => releases.push(resolve));
        return successResult(run);
      },
    });
    const scheduler = new WorkflowScheduler({
      registry: registryOf(definition),
      store,
      executor,
    });

    const first = await scheduler.enqueueManualRun({ name: definition.name });
    const second = await scheduler.enqueueManualRun({ name: definition.name });
    expect(first.status).toBe("started");
    expect(second.status).toBe("started");
    expect(first.runId).not.toBe(second.runId);
    expect(scheduler.activeRunCount(definition.name)).toBe(2);
    expect(await store.getRun(first.runId)).toBeDefined();
    expect(await store.getRun(second.runId)).toBeDefined();

    releases[0]?.();
    await waitFor(() => scheduler.activeRunCount(definition.name) === 1);
    releases[1]?.();
    await waitFor(() => scheduler.activeRunCount(definition.name) === 0);
  });

  it("throws for unknown, disabled, and invalid workflows before claiming a run", async () => {
    const store = new InMemoryWorkflowStore();
    let persistCalls = 0;
    const definition = workflowDefinition();
    const executor = mockExecutor(store, {
      persist: async () => {
        persistCalls += 1;
        throw new Error("persist should not run");
      },
    });
    const scheduler = new WorkflowScheduler({
      registry: registryOf(definition),
      store,
      executor,
    });

    await expect(scheduler.enqueueManualRun({ name: "missing" }))
      .rejects.toThrow("Unknown workflow: missing");

    const disabled = { ...definition, enabled: false };
    const disabledScheduler = new WorkflowScheduler({
      registry: registryOf(disabled),
      store,
      executor,
    });
    await expect(disabledScheduler.enqueueManualRun({ name: definition.name }))
      .rejects.toThrow("is disabled in its workflow file");

    await store.setState({
      name: definition.name,
      status: "invalid",
      activeVersionHash: definition.versionHash,
      sourcePath: definition.sourcePath,
      lastLoadedAt: 1,
      nextRunAt: null,
      lastRunAt: null,
      lastRunStatus: null,
      lastError: "broken yaml",
    });
    await expect(scheduler.enqueueManualRun({ name: definition.name }))
      .rejects.toThrow("is invalid and cannot run");

    expect(persistCalls).toBe(0);
    expect(scheduler.activeRunCount(definition.name)).toBe(0);
    expect(disabledScheduler.activeRunCount(definition.name)).toBe(0);
  });

  it("one-shots a stopped workflow because reason is always manual", async () => {
    const definition = workflowDefinition();
    const store = new InMemoryWorkflowStore();
    await store.setState({
      name: definition.name,
      status: "stopped",
      activeVersionHash: definition.versionHash,
      sourcePath: definition.sourcePath,
      lastLoadedAt: 1,
      nextRunAt: null,
      lastRunAt: null,
      lastRunStatus: null,
      lastError: null,
    });
    const executor = mockExecutor(store);
    const scheduler = new WorkflowScheduler({
      registry: registryOf(definition),
      store,
      executor,
    });

    const result = await scheduler.enqueueManualRun({ name: definition.name });
    expect(result.status).toBe("started");
    expect(result.runId).toBeTruthy();
    await waitFor(() => !scheduler.isRunning(definition.name));
  });

  it("does not overwrite lastRunStatus when schedule fails after a successful execute", async () => {
    const definition = {
      ...workflowDefinition(),
      triggers: [{ type: "schedule" as const, cron: "not-a-cron", timezone: "UTC" }],
    };
    const store = new InMemoryWorkflowStore();
    const executor = mockExecutor(store, {
      execute: async (run) => {
        const state = await store.getState(definition.name);
        if (state) {
          await store.setState({
            ...state,
            lastRunStatus: "success",
            lastError: null,
            lastRunAt: Date.now(),
          });
        }
        return successResult(run);
      },
    });
    const scheduler = new WorkflowScheduler({
      registry: registryOf(definition),
      store,
      executor,
    });

    const result = await scheduler.enqueueManualRun({ name: definition.name });
    expect(result.status).toBe("started");
    await waitFor(() => !scheduler.isRunning(definition.name));
    expect((await store.getState(definition.name))?.lastRunStatus).toBe("success");
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

function registryOf(definition: WorkflowDefinition): WorkflowRegistry {
  return {
    get: (name: string) => name === definition.name ? definition : undefined,
    snapshot: () => ({ definitions: new Map([[definition.name, definition]]), errors: [] }),
    onEvent: () => undefined,
  } as unknown as WorkflowRegistry;
}

function mockExecutor(
  store: InMemoryWorkflowStore,
  hooks: {
    persist?: (definition: WorkflowDefinition) => Promise<WorkflowRun>;
    execute?: (run: WorkflowRun) => Promise<{ summary: string; run: WorkflowRun }>;
  } = {},
): WorkflowExecutor {
  let seq = 0;
  return {
    persistNewRun: async (request: { definition: WorkflowDefinition }) => {
      if (hooks.persist) return hooks.persist(request.definition);
      seq += 1;
      const run = runningRow(request.definition, `worklog-run-${seq}`);
      await store.createRun(run);
      return run;
    },
    executePersistedRun: async (run: WorkflowRun) => {
      if (hooks.execute) return hooks.execute(run);
      return successResult(run);
    },
  } as unknown as WorkflowExecutor;
}

function runningRow(definition: WorkflowDefinition, id: string): WorkflowRun {
  return {
    id,
    workflowName: definition.name,
    workflowVersionHash: definition.versionHash,
    sourcePath: definition.sourcePath,
    reason: "manual",
    actorSlackUserId: null,
    status: "running",
    startedAt: Date.now(),
    finishedAt: null,
    artifactPath: `data/workflow-runs/${definition.name}/${id}.md`,
    providerSessionId: null,
    slackChannel: null,
    slackThreadTs: null,
    error: null,
  };
}

function successResult(run: WorkflowRun) {
  return {
    summary: "ok",
    run: { ...run, status: "success" as const, finishedAt: Date.now() },
  };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 500,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out waiting for condition");
}
