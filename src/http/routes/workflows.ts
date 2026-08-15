import { realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Config } from "../../config.ts";
import { log } from "../../logger.ts";
import { hashWorkflowContent } from "../../workflows/definition.ts";
import type { WorkflowRegistry } from "../../workflows/registry.ts";
import type { WorkflowScheduler } from "../../workflows/scheduler.ts";
import type { WorkflowStore } from "../../workflows/store.ts";
import type {
  WorkflowDefinition,
  WorkflowOutput,
  WorkflowRun,
  WorkflowRuntimeStatus,
  WorkflowSourceRoot,
} from "../../workflows/types.ts";
import { OVERLAY_WORKFLOW_ROOT, PUBLIC_WORKFLOW_ROOT } from "../../workflows/types.ts";
import type { DashboardAuditStore } from "../audit/interface.ts";

export type WorkflowAuth = {
  isAdmin(userId: string): Promise<boolean>;
  isExplicitAdmin(userId: string): Promise<boolean>;
};

export type WorkflowSlackPoster = {
  post(
    channel: string,
    threadTs: string | null,
    text: string,
  ): Promise<{ ts: string } | null>;
};

export type WorkflowRouteDeps = {
  registry: WorkflowRegistry;
  store: WorkflowStore;
  scheduler: Pick<
    WorkflowScheduler,
    | "isRunning"
    | "enqueueManualRun"
    | "startWorkflow"
    | "stopWorkflow"
    | "reconcile"
  >;
  config: Pick<Config, "adminSlackUserId">;
  sessionManager: WorkflowAuth;
  auditStore: DashboardAuditStore;
  slackPoster?: WorkflowSlackPoster;
  projectRoot?: string;
};

export function dashboardActor(config: Pick<Config, "adminSlackUserId">): string {
  return config.adminSlackUserId ?? "dashboard-operator";
}

export async function handleWorkflows(
  registry: WorkflowRegistry,
  store: WorkflowStore,
  scheduler: Pick<WorkflowScheduler, "isRunning">,
): Promise<Response> {
  const definitions = registry.all();
  const states = await store.listStates();
  const stateByName = new Map(states.map((state) => [state.name, state]));
  const workflows = await Promise.all(
    definitions.map(async (definition) => {
      const state = stateByName.get(definition.name) ?? null;
      const runs = (await store.listRuns(definition.name, 5)).map(projectRun);
      return {
        ...projectDefinition(definition),
        state,
        runs,
        displayStatus: workflowDisplayStatus(
          definition.enabled,
          state?.status,
          scheduler.isRunning(definition.name),
        ),
      };
    }),
  );

  return Response.json({
    workflows,
    errors: registry.getErrors(),
  });
}

export async function handleWorkflowDetail(
  name: string,
  deps: {
    registry: WorkflowRegistry;
    store: WorkflowStore;
    scheduler: Pick<WorkflowScheduler, "isRunning">;
    projectRoot?: string;
  },
): Promise<Response> {
  const projectRoot = deps.projectRoot ?? process.cwd();
  const definition = deps.registry.get(name);
  const disk = await readWorkflowDisk(name, definition, projectRoot);
  if (!definition && !disk) {
    return Response.json({ error: "not found" }, { status: 404 });
  }

  const sourcePath = disk?.sourcePath ?? definition?.sourcePath ?? "";
  const sourceRoot = disk?.sourceRoot ?? definition?.sourceRoot ?? "public";
  const markdown = disk?.markdown ?? "";
  const fileVersionHash = disk ? hashWorkflowContent(disk.markdown) : "";
  const loadedVersionHash = definition?.versionHash ?? null;
  const state = definition
    ? await deps.store.getState(definition.name) ?? null
    : await deps.store.getState(name) ?? null;
  const runs = (await deps.store.listRuns(name, 20)).map(projectRun);
  const errors = deps.registry.getErrors().filter((error) =>
    error.path === sourcePath || error.path.endsWith(`/${name}.workflow.md`)
  );

  return Response.json({
    workflow: definition
      ? {
        ...projectDefinition(definition),
        state,
        runs,
        displayStatus: workflowDisplayStatus(
          definition.enabled,
          state?.status,
          deps.scheduler.isRunning(definition.name),
        ),
      }
      : null,
    source: {
      markdown,
      sourceRoot,
      sourcePath,
      fileVersionHash,
      loadedVersionHash,
    },
    git: await probeWorkflowGit(disk?.absolutePath ?? sourcePath, projectRoot),
    runtimeUsesFile: Boolean(
      loadedVersionHash && fileVersionHash && fileVersionHash === loadedVersionHash,
    ),
    state,
    runs,
    errors,
  });
}

export async function handleWorkflowRun(
  name: string,
  req: Request,
  deps: WorkflowRouteDeps,
): Promise<Response> {
  const actorGate = await requireDashboardActor(deps, {
    action: "workflow.run",
    targetId: name,
  });
  if (actorGate instanceof Response) return actorGate;
  const { actor } = actorGate;

  const body = await readJsonObject(req);
  if (body instanceof Response) {
    await recordAudit(deps, {
      actor,
      action: "workflow.run",
      targetId: name,
      result: "error",
      error: "invalid json",
    });
    return body;
  }
  const instructions = readInstructions(body);
  if (instructions instanceof Response) {
    await recordAudit(deps, {
      actor,
      action: "workflow.run",
      targetId: name,
      request: body,
      result: "error",
      error: "invalid instructions",
    });
    return instructions;
  }

  const definition = deps.registry.get(name);
  if (!definition) {
    await recordAudit(deps, {
      actor,
      action: "workflow.run",
      targetId: name,
      request: { instructions },
      result: "error",
      error: "not found",
    });
    return Response.json({ error: "not found" }, { status: 404 });
  }
  if (!(await canManage(deps, actor, definition))) {
    return deny(deps, {
      actor,
      action: "workflow.run",
      targetId: name,
      request: { instructions },
    });
  }
  if (definition.nativeHandler && instructions) {
    await recordAudit(deps, {
      actor,
      action: "workflow.run",
      targetId: name,
      request: { instructions },
      result: "error",
      error: "native handler rejects instructions",
    });
    return Response.json(
      { error: `Workflow ${definition.name} uses a native handler and does not accept operator instructions.` },
      { status: 400 },
    );
  }

  try {
    const result = await deps.scheduler.enqueueManualRun({
      name: definition.name,
      actorSlackUserId: actor,
      instructions,
    });
    const slackTs = await postWorkflowNotice(
      deps,
      definition,
      result.status === "skipped" ? "skipped" : "ran",
      actor,
    );
    await recordAudit(deps, {
      actor,
      action: "workflow.run",
      targetId: name,
      request: { instructions },
      result: result.status === "skipped" ? "skipped" : "ok",
      slackTs,
    });
    log.info(
      "dashboard",
      `dashboard action=workflow.run name=${name} result=${result.status}`,
    );
    return Response.json(result, {
      status: result.status === "started" ? 202 : 200,
    });
  } catch (err) {
    return workflowMutationError(deps, {
      actor,
      action: "workflow.run",
      targetId: name,
      request: { instructions },
      err,
    });
  }
}

export async function handleWorkflowStart(
  name: string,
  deps: WorkflowRouteDeps,
): Promise<Response> {
  return handleStartStop(name, "start", deps);
}

export async function handleWorkflowStop(
  name: string,
  deps: WorkflowRouteDeps,
): Promise<Response> {
  return handleStartStop(name, "stop", deps);
}

export async function handleWorkflowReload(
  deps: WorkflowRouteDeps,
): Promise<Response> {
  const actorGate = await requireDashboardActor(deps, {
    action: "workflow.reload",
    targetId: "registry",
  });
  if (actorGate instanceof Response) return actorGate;
  const { actor } = actorGate;
  if (!(await deps.sessionManager.isAdmin(actor))) {
    return deny(deps, {
      actor,
      action: "workflow.reload",
      targetId: "registry",
    });
  }

  try {
    const snapshot = await deps.registry.reload();
    await deps.scheduler.reconcile(snapshot);
    const slackTs = await postReloadNotice(deps, actor, snapshot.definitions.size);
    await recordAudit(deps, {
      actor,
      action: "workflow.reload",
      targetId: "registry",
      request: { definitions: snapshot.definitions.size },
      result: "ok",
      slackTs,
    });
    log.info(
      "dashboard",
      `dashboard action=workflow.reload definitions=${snapshot.definitions.size} result=ok`,
    );
    return Response.json({
      definitions: snapshot.definitions.size,
      errors: snapshot.errors,
    });
  } catch (err) {
    return workflowMutationError(deps, {
      actor,
      action: "workflow.reload",
      targetId: "registry",
      err,
    });
  }
}

export function workflowDisplayStatus(
  enabled: boolean,
  schedulerStatus: WorkflowRuntimeStatus | undefined,
  isRunning: boolean,
): WorkflowRun["status"] | WorkflowRuntimeStatus {
  if (isRunning) return "running";
  return schedulerStatus ?? (enabled ? "active" : "stopped");
}

function projectDefinition(definition: WorkflowDefinition) {
  return {
    name: definition.name,
    enabled: definition.enabled,
    description: definition.description ?? null,
    sourcePath: definition.sourcePath,
    sourceRoot: definition.sourceRoot,
    versionHash: definition.versionHash,
    triggers: definition.triggers,
    outputs: definition.outputs,
    runner: definition.runner ?? null,
    nativeHandler: definition.nativeHandler ?? null,
    ownerSlackUserIds: definition.ownerSlackUserIds,
    permissions: definition.permissions,
    sourceMarkdown: false,
    concurrency: definition.concurrency,
  };
}

function projectRun(run: WorkflowRun) {
  return {
    id: run.id,
    reason: run.reason,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    artifactPath: run.artifactPath,
    providerSessionId: run.providerSessionId,
    slackChannel: run.slackChannel,
    slackThreadTs: run.slackThreadTs,
    error: run.error,
  };
}

async function handleStartStop(
  name: string,
  action: "start" | "stop",
  deps: WorkflowRouteDeps,
): Promise<Response> {
  const auditAction = action === "start" ? "workflow.start" : "workflow.stop";
  const actorGate = await requireDashboardActor(deps, {
    action: auditAction,
    targetId: name,
  });
  if (actorGate instanceof Response) return actorGate;
  const { actor } = actorGate;

  const definition = deps.registry.get(name);
  if (!definition) {
    await recordAudit(deps, {
      actor,
      action: auditAction,
      targetId: name,
      result: "error",
      error: "not found",
    });
    return Response.json({ error: "not found" }, { status: 404 });
  }
  if (!(await canManage(deps, actor, definition))) {
    return deny(deps, { actor, action: auditAction, targetId: name });
  }

  try {
    if (action === "start") await deps.scheduler.startWorkflow(name);
    else await deps.scheduler.stopWorkflow(name);
    const status = action === "start" ? "active" : "stopped";
    const slackTs = await postWorkflowNotice(deps, definition, action === "start" ? "started" : "stopped", actor);
    await recordAudit(deps, {
      actor,
      action: auditAction,
      targetId: name,
      result: "ok",
      slackTs,
    });
    log.info("dashboard", `dashboard action=${auditAction} name=${name} result=ok`);
    return Response.json({ name, status });
  } catch (err) {
    return workflowMutationError(deps, {
      actor,
      action: auditAction,
      targetId: name,
      err,
    });
  }
}

async function requireDashboardActor(
  deps: WorkflowRouteDeps,
  input: { action: string; targetId: string },
): Promise<{ actor: string } | Response> {
  const actor = dashboardActor(deps.config);
  if (
    !deps.config.adminSlackUserId &&
    !(await deps.sessionManager.isAdmin("dashboard-operator"))
  ) {
    return deny(deps, {
      actor,
      action: input.action,
      targetId: input.targetId,
      error: "dashboard actor is not an admin",
    });
  }
  return { actor };
}

async function canManage(
  deps: WorkflowRouteDeps,
  actor: string,
  definition: WorkflowDefinition,
): Promise<boolean> {
  return definition.ownerSlackUserIds.includes(actor) ||
    await deps.sessionManager.isAdmin(actor);
}

async function deny(
  deps: WorkflowRouteDeps,
  input: {
    actor: string;
    action: string;
    targetId: string;
    request?: Record<string, unknown>;
    error?: string;
  },
): Promise<Response> {
  const error = input.error ?? "dashboard actor is not an admin";
  await recordAudit(deps, {
    actor: input.actor,
    action: input.action,
    targetId: input.targetId,
    request: input.request,
    result: "denied",
    error,
  });
  log.info(
    "dashboard",
    `dashboard action=${input.action} name=${input.targetId} result=denied`,
  );
  return Response.json({ error }, { status: 403 });
}

async function workflowMutationError(
  deps: WorkflowRouteDeps,
  input: {
    actor: string;
    action: string;
    targetId: string;
    request?: Record<string, unknown>;
    err: unknown;
  },
): Promise<Response> {
  const message = formatError(input.err);
  const status = statusForWorkflowError(message);
  await recordAudit(deps, {
    actor: input.actor,
    action: input.action,
    targetId: input.targetId,
    request: input.request,
    result: "error",
    error: message,
  });
  log.info(
    "dashboard",
    `dashboard action=${input.action} name=${input.targetId} result=error`,
  );
  return Response.json({ error: message }, { status });
}

function statusForWorkflowError(message: string): number {
  if (message.startsWith("Unknown workflow:")) return 404;
  if (message.includes("is disabled") || message.includes("is invalid")) return 409;
  if (message.includes("does not accept operator instructions")) return 400;
  return 500;
}

async function recordAudit(
  deps: Pick<WorkflowRouteDeps, "auditStore">,
  input: {
    actor: string;
    action: string;
    targetId: string;
    request?: Record<string, unknown>;
    result: string;
    error?: string | null;
    slackTs?: string | null;
  },
): Promise<void> {
  await deps.auditStore.record({
    actor: input.actor,
    action: input.action,
    targetType: "workflow",
    targetId: input.targetId,
    request: input.request ?? {},
    result: input.result,
    error: input.error ?? null,
    slackTs: input.slackTs ?? null,
  });
}

async function postWorkflowNotice(
  deps: WorkflowRouteDeps,
  definition: WorkflowDefinition,
  verb: string,
  actor: string,
): Promise<string | null> {
  const dest = slackOutput(definition);
  if (!dest || !deps.slackPoster) return null;
  try {
    const posted = await deps.slackPoster.post(
      dest.channel,
      dest.threadTs,
      `*Dashboard* ${verb} *${definition.name}* · actor=${actor}`,
    );
    return posted?.ts ?? null;
  } catch (err) {
    log.warn(
      "dashboard",
      `workflow slack notice failed name=${definition.name}: ${formatError(err)}`,
    );
    return null;
  }
}

async function postReloadNotice(
  deps: WorkflowRouteDeps,
  actor: string,
  count: number,
): Promise<string | null> {
  if (!deps.slackPoster) return null;
  for (const definition of deps.registry.all()) {
    const dest = slackOutput(definition);
    if (!dest) continue;
    try {
      const posted = await deps.slackPoster.post(
        dest.channel,
        dest.threadTs,
        `*Dashboard* reloaded workflows (${count}) · actor=${actor}`,
      );
      return posted?.ts ?? null;
    } catch (err) {
      log.warn("dashboard", `workflow reload slack notice failed: ${formatError(err)}`);
      return null;
    }
  }
  return null;
}

function slackOutput(
  definition: WorkflowDefinition,
): { channel: string; threadTs: string | null } | null {
  const output = definition.outputs.find(
    (item): item is Exclude<WorkflowOutput, { type: "docs" }> =>
      item.type === "slack" || item.type === "slack-thread",
  );
  if (!output) return null;
  return {
    channel: output.channel,
    threadTs: output.type === "slack" ? output.threadTs ?? null : null,
  };
}

async function readJsonObject(
  req: Request,
): Promise<Record<string, unknown> | Response> {
  const text = await req.text();
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return Response.json({ error: "invalid json" }, { status: 400 });
    }
    return parsed as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
}

function readInstructions(
  body: Record<string, unknown>,
): string | null | Response {
  if (body.instructions == null) return null;
  if (typeof body.instructions !== "string") {
    return Response.json({ error: "instructions must be a string" }, { status: 400 });
  }
  const trimmed = body.instructions.trim();
  return trimmed ? body.instructions : null;
}

async function readWorkflowDisk(
  name: string,
  definition: WorkflowDefinition | undefined,
  projectRoot: string,
): Promise<{
  markdown: string;
  sourcePath: string;
  sourceRoot: WorkflowSourceRoot;
  absolutePath: string;
} | null> {
  const overlayRel = join(OVERLAY_WORKFLOW_ROOT, `${name}.workflow.md`);
  const publicRel = join(PUBLIC_WORKFLOW_ROOT, `${name}.workflow.md`);
  const overlayAbs = resolve(projectRoot, overlayRel);
  const publicAbs = resolve(projectRoot, publicRel);
  const overlay = Bun.file(overlayAbs);
  if (await overlay.exists()) {
    return {
      markdown: await overlay.text(),
      sourcePath: overlayRel,
      sourceRoot: "overlay",
      absolutePath: overlayAbs,
    };
  }
  const pub = Bun.file(publicAbs);
  if (await pub.exists()) {
    return {
      markdown: await pub.text(),
      sourcePath: publicRel,
      sourceRoot: "public",
      absolutePath: publicAbs,
    };
  }
  if (definition?.sourcePath) {
    const abs = resolve(projectRoot, definition.sourcePath);
    const file = Bun.file(abs);
    if (await file.exists()) {
      return {
        markdown: await file.text(),
        sourcePath: definition.sourcePath,
        sourceRoot: definition.sourceRoot,
        absolutePath: abs,
      };
    }
  }
  return null;
}

async function probeWorkflowGit(
  sourcePath: string,
  projectRoot: string,
): Promise<{
  sha: string | null;
  branch: string | null;
  detached: boolean;
  dirty: boolean;
}> {
  const empty = { sha: null, branch: null, detached: false, dirty: false };
  if (!sourcePath) return empty;
  const abs = existingRealpath(resolve(projectRoot, sourcePath));
  try {
    const toplevel = existingRealpath(
      (await git(dirname(abs), ["rev-parse", "--show-toplevel"])).trim(),
    );
    const sha = (await git(toplevel, ["rev-parse", "HEAD"])).trim();
    const branch = (await git(toplevel, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    const rel = relative(toplevel, abs);
    const porcelain = (await git(toplevel, [
      "status",
      "--porcelain",
      "--",
      rel,
    ])).trim();
    return {
      sha: sha || null,
      branch: branch === "HEAD" ? null : branch || null,
      detached: branch === "HEAD",
      dirty: porcelain.length > 0,
    };
  } catch {
    return empty;
  }
}

function existingRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exited] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exited !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
  return stdout;
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
