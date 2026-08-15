import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../config.ts";
import { InMemoryDashboardAuditStore } from "../audit/memory.ts";
import { hashWorkflowContent } from "../../workflows/definition.ts";
import type { WorkflowRegistry } from "../../workflows/registry.ts";
import { WorkflowScheduler } from "../../workflows/scheduler.ts";
import { InMemoryWorkflowStore } from "../../workflows/store.ts";
import type { WorkflowDefinition } from "../../workflows/types.ts";
import { startHttpServer, type HttpServerDeps } from "../server.ts";
import {
  handleWorkflowDetail,
  handleWorkflowReload,
  handleWorkflowRun,
  handleWorkflowStart,
  handleWorkflowStop,
  type WorkflowRouteDeps,
} from "./workflows.ts";

describe("workflow write routes", () => {
  it("runs through enqueueManualRun and returns 202 started", async () => {
    const received: Array<unknown> = [];
    const enqueueManualRun = mock(async (options: {
      name: string;
      actorSlackUserId?: string | null;
      instructions?: string | null;
    }) => {
      received.push(options);
      return {
        status: "started" as const,
        runId: "worklog-run-1",
        summary: "Started *worklog*.",
      };
    });
    const deps = baseDeps({
      scheduler: {
        enqueueManualRun,
        isRunning: () => false,
        startWorkflow: async () => undefined,
        stopWorkflow: async () => undefined,
        reconcile: async () => undefined,
      },
    });

    const response = await handleWorkflowRun(
      "worklog",
      jsonReq({ instructions: "only widgets" }),
      deps,
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      status: "started",
      runId: "worklog-run-1",
      summary: "Started *worklog*.",
    });
    expect(enqueueManualRun).toHaveBeenCalledTimes(1);
    expect(received).toEqual([{
      name: "worklog",
      actorSlackUserId: "dashboard-operator",
      instructions: "only widgets",
    }]);
    expect("runNow" in deps.scheduler).toBe(false);
    const audit = await deps.auditStore.list({ action: "workflow.run" });
    expect(audit[0]).toMatchObject({
      result: "ok",
      actor: "dashboard-operator",
      request: { instructions: "only widgets" },
    });
  });

  it("returns 200 skipped with an empty runId", async () => {
    const deps = baseDeps({
      scheduler: {
        enqueueManualRun: async () => ({
          status: "skipped" as const,
          runId: "" as const,
          summary: "Skipped *worklog*: already running.",
        }),
        isRunning: () => true,
        startWorkflow: async () => undefined,
        stopWorkflow: async () => undefined,
        reconcile: async () => undefined,
      },
    });

    const response = await handleWorkflowRun("worklog", jsonReq({}), deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "skipped",
      runId: "",
      summary: "Skipped *worklog*: already running.",
    });
    const audit = await deps.auditStore.list({ action: "workflow.run" });
    expect(audit[0]?.result).toBe("skipped");
  });

  it("starts a second overlapping run when concurrency is parallel", async () => {
    const store = new InMemoryWorkflowStore();
    const definition = workflowDefinition({ concurrency: "parallel" });
    const releases: Array<() => void> = [];
    let seq = 0;
    const scheduler = new WorkflowScheduler({
      registry: registryOf(definition),
      store,
      executor: {
        persistNewRun: async () => {
          seq += 1;
          const run = {
            id: `run-${seq}`,
            workflowName: definition.name,
            workflowVersionHash: definition.versionHash,
            sourcePath: definition.sourcePath,
            reason: "manual" as const,
            actorSlackUserId: null,
            status: "running" as const,
            startedAt: Date.now(),
            finishedAt: null,
            artifactPath: "data/workflow-runs/worklog/run.md",
            providerSessionId: null,
            slackChannel: null,
            slackThreadTs: null,
            error: null,
          };
          await store.createRun(run);
          return run;
        },
        executePersistedRun: async (run: { id: string }) => {
          await new Promise<void>((resolve) => releases.push(resolve));
          return { summary: "ok", run };
        },
      } as never,
    });
    const deps = baseDeps({
      registry: registryOf(definition),
      store,
      scheduler,
    });

    const first = await handleWorkflowRun("worklog", jsonReq({}), deps);
    const second = await handleWorkflowRun("worklog", jsonReq({}), deps);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(((await first.json()) as { runId: string }).runId).toBe("run-1");
    expect(((await second.json()) as { runId: string }).runId).toBe("run-2");
    expect(scheduler.activeRunCount("worklog")).toBe(2);
    for (const release of releases) release();
    await waitFor(() => scheduler.activeRunCount("worklog") === 0);
  });

  it("rejects native-handler instructions with 400", async () => {
    const enqueueManualRun = mock(async () => {
      throw new Error("enqueue should not run");
    });
    const definition = workflowDefinition({
      nativeHandler: "memory-dedup-sweep",
    });
    definition.runner = undefined;
    const deps = baseDeps({
      registry: registryOf(definition),
      scheduler: {
        enqueueManualRun,
        isRunning: () => false,
        startWorkflow: async () => undefined,
        stopWorkflow: async () => undefined,
        reconcile: async () => undefined,
      },
    });

    const response = await handleWorkflowRun(
      "worklog",
      jsonReq({ instructions: "only recent claims" }),
      deps,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Workflow worklog uses a native handler and does not accept operator instructions.",
    });
    expect(enqueueManualRun).not.toHaveBeenCalled();
  });

  it("returns 409 when the workflow file is disabled", async () => {
    const definition = workflowDefinition({ enabled: false });
    const deps = baseDeps({
      registry: registryOf(definition),
      scheduler: {
        enqueueManualRun: async () => {
          throw new Error("Workflow worklog is disabled in its workflow file.");
        },
        startWorkflow: async () => {
          throw new Error("Workflow worklog is disabled in its workflow file. Change enabled to true before starting it.");
        },
        isRunning: () => false,
        stopWorkflow: async () => undefined,
        reconcile: async () => undefined,
      },
    });

    const run = await handleWorkflowRun("worklog", jsonReq({}), deps);
    expect(run.status).toBe(409);
    const start = await handleWorkflowStart("worklog", deps);
    expect(start.status).toBe(409);
  });

  it("returns 403 when the dashboard actor is not an admin", async () => {
    const enqueueManualRun = mock(async () => {
      throw new Error("must not enqueue");
    });
    const deps = baseDeps({
      sessionManager: {
        isAdmin: async () => false,
        isExplicitAdmin: async () => false,
      },
      scheduler: {
        enqueueManualRun,
        isRunning: () => false,
        startWorkflow: async () => undefined,
        stopWorkflow: async () => undefined,
        reconcile: async () => undefined,
      },
    });

    const response = await handleWorkflowRun("worklog", jsonReq({}), deps);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "dashboard actor is not an admin",
    });
    expect(enqueueManualRun).not.toHaveBeenCalled();
    const audit = await deps.auditStore.list();
    expect(audit[0]?.result).toBe("denied");
  });

  it("starts and stops with the same owner/admin gate as Slack", async () => {
    const startWorkflow = mock(async () => undefined);
    const stopWorkflow = mock(async () => undefined);
    const deps = baseDeps({
      scheduler: {
        enqueueManualRun: async () => ({
          status: "started" as const,
          runId: "x",
          summary: "Started *worklog*.",
        }),
        startWorkflow,
        stopWorkflow,
        isRunning: () => false,
        reconcile: async () => undefined,
      },
    });

    const started = await handleWorkflowStart("worklog", deps);
    expect(started.status).toBe(200);
    expect(await started.json()).toEqual({ name: "worklog", status: "active" });
    const stopped = await handleWorkflowStop("worklog", deps);
    expect(stopped.status).toBe(200);
    expect(await stopped.json()).toEqual({ name: "worklog", status: "stopped" });
    expect(startWorkflow).toHaveBeenCalledTimes(1);
    expect(stopWorkflow).toHaveBeenCalledTimes(1);
  });

  it("reloads definitions for an admin actor", async () => {
    const reload = mock(async () => ({
      definitions: new Map([["worklog", workflowDefinition()]]),
      errors: [],
    }));
    const reconcile = mock(async () => undefined);
    const deps = baseDeps({
      registry: {
        ...registryOf(workflowDefinition()),
        reload,
      } as unknown as WorkflowRegistry,
      scheduler: {
        enqueueManualRun: async () => ({
          status: "started" as const,
          runId: "x",
          summary: "ok",
        }),
        isRunning: () => false,
        startWorkflow: async () => undefined,
        stopWorkflow: async () => undefined,
        reconcile,
      },
    });

    const response = await handleWorkflowReload(deps);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ definitions: 1, errors: [] });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("returns on-disk markdown and both hashes when the loaded definition is stale", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junior-wf-detail-"));
    try {
      mkdirSync(join(dir, "agents-org", "workflows"), { recursive: true });
      const markdown = [
        "---",
        "name: worklog",
        "enabled: true",
        "ownerSlackUserIds: []",
        "this is not valid yaml::::",
        "---",
        "broken overlay",
      ].join("\n");
      writeFileSync(join(dir, "agents-org", "workflows", "worklog.workflow.md"), markdown);
      const definition = workflowDefinition({
        versionHash: "loaded-lkg-hash",
        sourcePath: "agents-org/workflows/worklog.workflow.md",
        sourceRoot: "overlay",
      });
      const registry = {
        get: () => definition,
        getErrors: () => [{
          path: "agents-org/workflows/worklog.workflow.md",
          message: "invalid yaml",
        }],
        all: () => [definition],
      } as unknown as WorkflowRegistry;
      const response = await handleWorkflowDetail("worklog", {
        registry,
        store: new InMemoryWorkflowStore(),
        scheduler: { isRunning: () => false },
        projectRoot: dir,
      });
      expect(response.status).toBe(200);
      const body = await response.json() as {
        runtimeUsesFile: boolean;
        source: {
          markdown: string;
          fileVersionHash: string;
          loadedVersionHash: string | null;
        };
      };
      expect(body.source.markdown).toBe(markdown);
      expect(body.source.fileVersionHash).toBe(hashWorkflowContent(markdown));
      expect(body.source.loadedVersionHash).toBe("loaded-lkg-hash");
      expect(body.runtimeUsesFile).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("workflow nested routing", () => {
  let server: ReturnType<typeof startHttpServer> | undefined;

  afterEach(() => {
    server?.stop(true);
    server = undefined;
  });

  it("returns 405 on the wrong method and keeps /reload off the :name route", async () => {
    server = startHttpServer(stubServerDeps());
    const base = `http://127.0.0.1:${server.port}`;

    const postList = await fetch(`${base}/api/workflows`, { method: "POST" });
    expect(postList.status).toBe(405);
    expect(await postList.json()).toEqual({ error: "method not allowed" });

    const getReload = await fetch(`${base}/api/workflows/reload`);
    expect(getReload.status).toBe(405);

    const getRun = await fetch(`${base}/api/workflows/worklog/run`);
    expect(getRun.status).toBe(405);

    const postHealth = await fetch(`${base}/api/health`, { method: "POST" });
    expect(postHealth.status).toBe(405);
  });
});

function jsonReq(body: Record<string, unknown>): Request {
  return new Request("http://127.0.0.1/api/workflows/worklog/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function workflowDefinition(
  overrides: Partial<WorkflowDefinition> = {},
): WorkflowDefinition {
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
    ...overrides,
  };
}

function registryOf(definition: WorkflowDefinition): WorkflowRegistry {
  return {
    get: (name: string) => name === definition.name ? definition : undefined,
    all: () => [definition],
    getErrors: () => [],
    snapshot: () => ({ definitions: new Map([[definition.name, definition]]), errors: [] }),
    onEvent: () => undefined,
    reload: async () => ({
      definitions: new Map([[definition.name, definition]]),
      errors: [],
    }),
  } as unknown as WorkflowRegistry;
}

function baseDeps(overrides: Partial<WorkflowRouteDeps> = {}): WorkflowRouteDeps {
  const definition = workflowDefinition();
  return {
    registry: registryOf(definition),
    store: new InMemoryWorkflowStore(),
    scheduler: {
      enqueueManualRun: async () => ({
        status: "started",
        runId: "run-1",
        summary: "Started *worklog*.",
      }),
      isRunning: () => false,
      startWorkflow: async () => undefined,
      stopWorkflow: async () => undefined,
      reconcile: async () => undefined,
    },
    config: { adminSlackUserId: null },
    sessionManager: {
      isAdmin: async () => true,
      isExplicitAdmin: async () => false,
    },
    auditStore: new InMemoryDashboardAuditStore(),
    ...overrides,
  };
}

function stubServerDeps(): HttpServerDeps {
  return {
    store: {} as HttpServerDeps["store"],
    config: { http: { enabled: true, port: 0 }, adminSlackUserId: null } as Config,
    devServerManager: {} as HttpServerDeps["devServerManager"],
    devServerQueue: {} as HttpServerDeps["devServerQueue"],
    repos: [],
    workflowRegistry: {} as HttpServerDeps["workflowRegistry"],
    workflowScheduler: {} as HttpServerDeps["workflowScheduler"],
    workflowStore: {} as HttpServerDeps["workflowStore"],
    pipelineStore: {} as HttpServerDeps["pipelineStore"],
    usageStore: {} as HttpServerDeps["usageStore"],
    auditStore: {} as HttpServerDeps["auditStore"],
    sessionManager: {
      isAdmin: async () => true,
      isExplicitAdmin: async () => false,
    },
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
