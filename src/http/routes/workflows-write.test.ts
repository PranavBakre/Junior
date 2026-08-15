import { afterEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../config.ts";
import { InMemoryDashboardAuditStore } from "../audit/memory.ts";
import { hashWorkflowContent } from "../../workflows/definition.ts";
import { WorkflowRegistry } from "../../workflows/registry.ts";
import { WorkflowScheduler } from "../../workflows/scheduler.ts";
import { InMemoryWorkflowStore } from "../../workflows/store.ts";
import type { WorkflowDefinition } from "../../workflows/types.ts";
import { startHttpServer, type HttpServerDeps } from "../server.ts";
import {
  handleWorkflowCreate,
  handleWorkflowDetail,
  handleWorkflowPut,
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

  it("probes git from the overlay file's toplevel, not Junior", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junior-wf-git-"));
    try {
      const overlayRoot = join(dir, "agents-org");
      const fileRel = join("workflows", "worklog.workflow.md");
      mkdirSync(join(overlayRoot, "workflows"), { recursive: true });
      writeFileSync(join(overlayRoot, fileRel), "# overlay\n");
      await git(overlayRoot, ["init", "-b", "overlay-branch"]);
      await git(overlayRoot, ["add", fileRel]);
      await git(overlayRoot, [
        "-c", "user.name=t",
        "-c", "user.email=t@t.test",
        "-c", "commit.gpgsign=false",
        "commit", "-m", "overlay",
      ]);
      const overlaySha = (await git(overlayRoot, ["rev-parse", "HEAD"])).trim();

      await git(dir, ["init", "-b", "junior-main"]);
      writeFileSync(join(dir, "README.md"), "parent\n");
      await git(dir, ["add", "README.md"]);
      await git(dir, [
        "-c", "user.name=t",
        "-c", "user.email=t@t.test",
        "-c", "commit.gpgsign=false",
        "commit", "-m", "parent",
      ]);
      const parentSha = (await git(dir, ["rev-parse", "HEAD"])).trim();
      expect(parentSha).not.toBe(overlaySha);

      writeFileSync(join(overlayRoot, fileRel), "# overlay dirty\n");
      const definition = workflowDefinition({
        sourcePath: "agents-org/workflows/worklog.workflow.md",
        sourceRoot: "overlay",
      });
      const response = await handleWorkflowDetail("worklog", {
        registry: registryOf(definition),
        store: new InMemoryWorkflowStore(),
        scheduler: { isRunning: () => false },
        projectRoot: dir,
      });
      const body = await response.json() as {
        git: {
          sha: string | null;
          branch: string | null;
          detached: boolean;
          dirty: boolean;
          parent?: { branch: string | null; detached: boolean };
        };
      };
      expect(body.git).toMatchObject({
        sha: overlaySha,
        branch: "overlay-branch",
        detached: false,
        dirty: true,
        merging: false,
        rebasing: false,
      });
      expect(body.git.parent).toMatchObject({
        detached: false,
        branch: "junior-main",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("workflow create/edit routes", () => {
  it("validates PUT without writing when validate=1", async () => {
    const dir = tempDir();
    try {
      const original = validMarkdown();
      writeFileSync(join(dir, "workflows", "worklog.workflow.md"), original);
      const deps = baseDeps({ projectRoot: dir });
      const response = await handleWorkflowPut(
        "worklog",
        jsonWriteReq("PUT", "http://127.0.0.1/api/workflows/worklog?validate=1", {
          markdown: validMarkdown("worklog", "validated only"),
        }),
        deps,
      );
      expect(response.status).toBe(200);
      const body = await response.json() as { valid: boolean; versionHash: string };
      expect(body.valid).toBe(true);
      expect(body.versionHash).toBe(hashWorkflowContent(validMarkdown("worklog", "validated only")));
      expect(await Bun.file(join(dir, "workflows", "worklog.workflow.md")).text()).toBe(original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns 400 with errors for invalid markdown and does not write", async () => {
    const dir = tempDir();
    try {
      const original = validMarkdown();
      writeFileSync(join(dir, "workflows", "worklog.workflow.md"), original);
      const response = await handleWorkflowPut(
        "worklog",
        jsonWriteReq("PUT", "http://127.0.0.1/api/workflows/worklog", {
          markdown: "---\nname: worklog\nenabled: true\nownerSlackUserIds: []\n---\nno schema",
        }),
        baseDeps({ projectRoot: dir }),
      );
      expect(response.status).toBe(400);
      const body = await response.json() as { error: string; errors: Array<{ message: string }> };
      expect(body.error).toBe("invalid workflow");
      expect(body.errors[0]?.message).toContain("triggers");
      expect(await Bun.file(join(dir, "workflows", "worklog.workflow.md")).text()).toBe(original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns 400 when PUT omits expectedVersionHash", async () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, "workflows", "worklog.workflow.md"), validMarkdown());
      const response = await handleWorkflowPut(
        "worklog",
        jsonWriteReq("PUT", "http://127.0.0.1/api/workflows/worklog", {
          markdown: validMarkdown("worklog", "new"),
        }),
        baseDeps({ projectRoot: dir }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "expectedVersionHash is required" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns 409 when expectedVersionHash does not match the on-disk file", async () => {
    const dir = tempDir();
    try {
      const original = validMarkdown();
      writeFileSync(join(dir, "workflows", "worklog.workflow.md"), original);
      const response = await handleWorkflowPut(
        "worklog",
        jsonWriteReq("PUT", "http://127.0.0.1/api/workflows/worklog", {
          markdown: validMarkdown("worklog", "new"),
          expectedVersionHash: "deadbeefdeadbeef",
        }),
        baseDeps({ projectRoot: dir }),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: "version hash mismatch",
        fileVersionHash: hashWorkflowContent(original),
      });
      expect(await Bun.file(join(dir, "workflows", "worklog.workflow.md")).text()).toBe(original);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows PUT when the registry name is missing but the overlay file exists", async () => {
    const pair = await initOverlayPairForHttp();
    try {
      const original = await Bun.file(
        join(pair.overlay, "workflows", "worklog.workflow.md"),
      ).text();
      const registry = {
        ...registryOf(workflowDefinition({
          sourcePath: "agents-org/workflows/worklog.workflow.md",
          sourceRoot: "overlay",
        })),
        get: () => undefined,
        all: () => [],
      } as unknown as WorkflowRegistry;
      const next = validMarkdown("worklog", "from overlay file");
      const response = await handleWorkflowPut(
        "worklog",
        jsonWriteReq("PUT", "http://127.0.0.1/api/workflows/worklog", {
          markdown: next,
          expectedVersionHash: hashWorkflowContent(original),
        }),
        baseDeps({ registry, projectRoot: pair.junior }),
      );
      expect(response.status).toBe(200);
      const body = await response.json() as {
        versionHash: string;
        sourceRoot: string;
        overlayCommitted: boolean;
      };
      expect(body.sourceRoot).toBe("overlay");
      expect(body.overlayCommitted).toBe(true);
      expect(body.versionHash).toBe(hashWorkflowContent(next));
      expect(await Bun.file(join(pair.overlay, "workflows", "worklog.workflow.md")).text())
        .toBe(next);
    } finally {
      rmSync(pair.root, { recursive: true, force: true });
    }
  }, 15_000);

  it("commits a public edit and returns the new file hash", async () => {
    const dir = await initJuniorRepo();
    try {
      mkdirSync(join(dir, "workflows"), { recursive: true });
      const original = validMarkdown();
      writeFileSync(join(dir, "workflows", "worklog.workflow.md"), original);
      await git(dir, ["add", "--", "workflows/worklog.workflow.md"]);
      await git(dir, ["commit", "-m", "public workflow"]);
      const next = validMarkdown("worklog", "edited from dashboard");
      const response = await handleWorkflowPut(
        "worklog",
        jsonWriteReq("PUT", "http://127.0.0.1/api/workflows/worklog", {
          markdown: next,
          expectedVersionHash: hashWorkflowContent(original),
        }),
        baseDeps({ projectRoot: dir }),
      );
      expect(response.status).toBe(200);
      const body = await response.json() as {
        versionHash: string;
        sourceRoot: string;
        overlayCommitted: boolean;
        commit: { sha: string; branch: string; repo: string };
      };
      expect(body.sourceRoot).toBe("public");
      expect(body.overlayCommitted).toBe(false);
      expect(body.versionHash).toBe(hashWorkflowContent(next));
      expect(body.commit.branch).toBe("main");
      expect(body.commit.repo).toBe("junior");
      expect(await Bun.file(join(dir, "workflows", "worklog.workflow.md")).text()).toBe(next);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pauses and resumes registry reloads around a successful PUT", async () => {
    const dir = await initJuniorRepo();
    try {
      mkdirSync(join(dir, "workflows"), { recursive: true });
      const original = validMarkdown();
      writeFileSync(join(dir, "workflows", "worklog.workflow.md"), original);
      await git(dir, ["add", "--", "workflows/worklog.workflow.md"]);
      await git(dir, ["commit", "-m", "public workflow"]);
      const calls: string[] = [];
      const registry = {
        ...registryOf(workflowDefinition()),
        pauseReloads: () => {
          calls.push("pause");
        },
        resumeReloads: async () => {
          calls.push("resume");
        },
      } as unknown as WorkflowRegistry;
      const response = await handleWorkflowPut(
        "worklog",
        jsonWriteReq("PUT", "http://127.0.0.1/api/workflows/worklog", {
          markdown: validMarkdown("worklog", "wrapped"),
          expectedVersionHash: hashWorkflowContent(original),
        }),
        baseDeps({ registry, projectRoot: dir }),
      );
      expect(response.status).toBe(200);
      expect(calls).toEqual(["pause", "resume"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it("creates a public workflow with 201", async () => {
    const dir = await initJuniorRepo();
    try {
      const markdown = validMarkdown("newlog");
      const response = await handleWorkflowCreate(
        jsonWriteReq("POST", "http://127.0.0.1/api/workflows", {
          name: "newlog",
          markdown,
          sourceRoot: "public",
        }),
        baseDeps({ projectRoot: dir }),
      );
      expect(response.status).toBe(201);
      const body = await response.json() as {
        name: string;
        versionHash: string;
        sourcePath: string;
      };
      expect(body.name).toBe("newlog");
      expect(body.sourcePath).toBe("workflows/newlog.workflow.md");
      expect(body.versionHash).toBe(hashWorkflowContent(markdown));
      expect(await Bun.file(join(dir, "workflows", "newlog.workflow.md")).text()).toBe(markdown);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serializes overlapping creates of the same name", async () => {
    const dir = await initJuniorRepo();
    try {
      mkdirSync(join(dir, "workflows"), { recursive: true });
      const registry = new WorkflowRegistry({
        repos: [],
        roots: [{ path: join(dir, "workflows"), sourceRoot: "public" }],
      });
      await registry.reload();
      const deps = baseDeps({ registry, projectRoot: dir });
      const req = () =>
        jsonWriteReq("POST", "http://127.0.0.1/api/workflows", {
          name: "newlog",
          markdown: validMarkdown("newlog"),
          sourceRoot: "public",
        });
      const [first, second] = await Promise.all([
        handleWorkflowCreate(req(), deps),
        handleWorkflowCreate(req(), deps),
      ]);
      const statuses = [first.status, second.status].sort((a, b) => a - b);
      expect(statuses).toEqual([201, 409]);
      const bodies = await Promise.all([first.json(), second.json()]) as Array<{
        error?: string;
      }>;
      expect(bodies.some((body) => body.error === "workflow already exists")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it("refuses a name collision in the chosen root", async () => {
    const dir = tempDir();
    try {
      writeFileSync(join(dir, "workflows", "worklog.workflow.md"), validMarkdown());
      const response = await handleWorkflowCreate(
        jsonWriteReq("POST", "http://127.0.0.1/api/workflows", {
          name: "worklog",
          markdown: validMarkdown(),
          sourceRoot: "public",
        }),
        baseDeps({ projectRoot: dir }),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "workflow already exists" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows overlay create when a public file already exists", async () => {
    const pair = await initOverlayPairForHttp();
    try {
      writeFileSync(join(pair.junior, "workflows", "worklog.workflow.md"), validMarkdown());
      await git(pair.junior, ["add", "--", "workflows/worklog.workflow.md"]);
      await git(pair.junior, ["commit", "-m", "public"]);
      rmSync(join(pair.overlay, "workflows", "worklog.workflow.md"));
      await git(pair.overlay, ["add", "--", "workflows/worklog.workflow.md"]);
      await git(pair.overlay, ["commit", "-m", "remove overlay"]);

      const markdown = validMarkdown("worklog", "overlay override");
      const response = await handleWorkflowCreate(
        jsonWriteReq("POST", "http://127.0.0.1/api/workflows", {
          name: "worklog",
          markdown,
          sourceRoot: "overlay",
        }),
        baseDeps({ projectRoot: pair.junior }),
      );
      expect(response.status).toBe(201);
      const body = await response.json() as { sourceRoot: string; overlayCommitted: boolean };
      expect(body.sourceRoot).toBe("overlay");
      expect(body.overlayCommitted).toBe(true);
    } finally {
      rmSync(pair.root, { recursive: true, force: true });
    }
  }, 15_000);

  it("refuses public create when an overlay already exists", async () => {
    const dir = tempDir();
    try {
      mkdirSync(join(dir, "agents-org", "workflows"), { recursive: true });
      writeFileSync(join(dir, "agents-org", "workflows", "worklog.workflow.md"), validMarkdown());
      const response = await handleWorkflowCreate(
        jsonWriteReq("POST", "http://127.0.0.1/api/workflows", {
          name: "worklog",
          markdown: validMarkdown(),
          sourceRoot: "public",
        }),
        baseDeps({ projectRoot: dir }),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "overlay shadows this name" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an invalid create name and a missing sourceRoot", async () => {
    const missingRoot = await handleWorkflowCreate(
      jsonWriteReq("POST", "http://127.0.0.1/api/workflows", {
        name: "worklog",
        markdown: validMarkdown(),
      }),
      baseDeps(),
    );
    expect(missingRoot.status).toBe(400);
    expect(await missingRoot.json()).toEqual({ error: "sourceRoot is required" });

    const badName = await handleWorkflowCreate(
      jsonWriteReq("POST", "http://127.0.0.1/api/workflows", {
        name: "Nope",
        markdown: validMarkdown(),
        sourceRoot: "public",
      }),
      baseDeps(),
    );
    expect(badName.status).toBe(400);
    expect(await badName.json()).toEqual({ error: "invalid workflow name" });
  });

  it("returns 403 for create/edit when the dashboard actor is not an admin", async () => {
    const deps = baseDeps({
      sessionManager: {
        isAdmin: async () => false,
        isExplicitAdmin: async () => false,
      },
    });
    const created = await handleWorkflowCreate(
      jsonWriteReq("POST", "http://127.0.0.1/api/workflows", {
        name: "worklog",
        markdown: validMarkdown(),
        sourceRoot: "public",
      }),
      deps,
    );
    expect(created.status).toBe(403);
    const updated = await handleWorkflowPut(
      "worklog",
      jsonWriteReq("PUT", "http://127.0.0.1/api/workflows/worklog", {
        markdown: validMarkdown(),
      }),
      deps,
    );
    expect(updated.status).toBe(403);
  });

  it("returns 409 when the target repo is detached", async () => {
    const dir = await initJuniorRepo();
    try {
      mkdirSync(join(dir, "workflows"), { recursive: true });
      writeFileSync(join(dir, "workflows", "worklog.workflow.md"), validMarkdown());
      await git(dir, ["add", "--", "workflows/worklog.workflow.md"]);
      await git(dir, ["commit", "-m", "workflow"]);
      await git(dir, ["checkout", "--detach"]);
      const response = await handleWorkflowPut(
        "worklog",
        jsonWriteReq("PUT", "http://127.0.0.1/api/workflows/worklog", {
          markdown: validMarkdown("worklog", "nope"),
          expectedVersionHash: hashWorkflowContent(validMarkdown()),
          commitHereAnyway: true,
        }),
        baseDeps({ projectRoot: dir }),
      );
      expect(response.status).toBe(409);
      expect(((await response.json()) as { error: string }).error).toBe("detached-head");
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

    const postName = await fetch(`${base}/api/workflows/worklog`, { method: "POST" });
    expect(postName.status).toBe(405);
    expect(await postName.json()).toEqual({ error: "method not allowed" });

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

function jsonWriteReq(
  method: string,
  url: string,
  body: Record<string, unknown>,
): Request {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function validMarkdown(name = "worklog", body = "Do the thing."): string {
  return [
    "---",
    `name: ${name}`,
    "enabled: true",
    "ownerSlackUserIds: []",
    "triggers:",
    "  - type: command",
    `    command: ${name}`,
    "outputs:",
    "  - type: docs",
    `    path: data/workflow-runs/${name}`,
    "permissions:",
    "  tools:",
    "    - docs.write",
    "---",
    body,
  ].join("\n");
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "junior-wf-http-"));
  mkdirSync(join(dir, "workflows"), { recursive: true });
  return dir;
}

async function initJuniorRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "junior-wf-http-repo-"));
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.name", "t"]);
  await git(dir, ["config", "user.email", "t@t.test"]);
  await git(dir, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "README.md"), "junior\n");
  await git(dir, ["add", "--", "README.md"]);
  await git(dir, ["commit", "-m", "init"]);
  return dir;
}

async function initOverlayPairForHttp(): Promise<{
  root: string;
  junior: string;
  overlay: string;
}> {
  const junior = await initJuniorRepo();
  const overlay = join(junior, "agents-org");
  mkdirSync(join(overlay, "workflows"), { recursive: true });
  await git(overlay, ["init", "-b", "main"]);
  await git(overlay, ["config", "user.name", "t"]);
  await git(overlay, ["config", "user.email", "t@t.test"]);
  await git(overlay, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(overlay, "workflows", "worklog.workflow.md"), validMarkdown());
  await git(overlay, ["add", "--", "workflows/worklog.workflow.md"]);
  await git(overlay, ["commit", "-m", "overlay"]);
  writeFileSync(
    join(junior, ".gitmodules"),
    '[submodule "agents-org"]\n\tpath = agents-org\n\turl = ./agents-org\n',
  );
  mkdirSync(join(junior, "workflows"), { recursive: true });
  await git(junior, ["add", "--", ".gitmodules", "agents-org"]);
  await git(junior, ["commit", "-m", "add overlay"]);
  await git(overlay, ["checkout", "-B", "main"]);
  return { root: junior, junior, overlay };
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
    pauseReloads: () => undefined,
    resumeReloads: async () => undefined,
    validationContext: () => ({ repos: [], builtInCommands: new Set<string>() }),
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

async function git(cwd: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exited] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exited !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout;
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
