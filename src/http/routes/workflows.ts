import { existsSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Config, RepoConfig } from "../../config.ts";
import { log } from "../../logger.ts";
import {
  hashWorkflowContent,
  validateWorkflowMarkdown,
  WORKFLOW_NAME_RE,
} from "../../workflows/definition.ts";
import {
  defaultWorkflowCommitMessage,
  isProtectedBranch,
  overlayWorkflowsRootExists,
  probeWorkflowRepo,
  writeDashboardWorkflow,
  type WorkflowGitStatus,
} from "../../workflows/git-commit.ts";
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
  repos?: RepoConfig[];
};

export function dashboardActor(config: Pick<Config, "adminSlackUserId">): string {
  return config.adminSlackUserId ?? "dashboard-operator";
}

export async function handleWorkflows(
  registry: WorkflowRegistry,
  store: WorkflowStore,
  scheduler: Pick<WorkflowScheduler, "isRunning">,
  projectRoot?: string,
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

  const root = projectRoot ?? process.cwd();
  return Response.json({
    workflows,
    errors: registry.getErrors(),
    overlayRootExists: overlayWorkflowsRootExists(root),
    git: {
      junior: await probeWorkflowRepo(root),
      overlay: overlayWorkflowsRootExists(root) || existsSync(join(root, "agents-org"))
        ? await probeWorkflowRepo(join(root, "agents-org"))
        : null,
    },
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
      overlayExists: existsSync(join(projectRoot, OVERLAY_WORKFLOW_ROOT, `${name}.workflow.md`)),
    },
    git: await probeWorkflowGitDetail(disk, sourceRoot, projectRoot),
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

export async function handleWorkflowPut(
  name: string,
  req: Request,
  deps: WorkflowRouteDeps,
): Promise<Response> {
  const actorGate = await requireWriteActor(deps, {
    action: "workflow.update",
    targetId: name,
  });
  if (actorGate instanceof Response) return actorGate;
  const { actor } = actorGate;

  const body = await readJsonObject(req);
  if (body instanceof Response) {
    await recordAudit(deps, {
      actor,
      action: "workflow.update",
      targetId: name,
      result: "error",
      error: "invalid json",
    });
    return body;
  }

  const markdown = readMarkdown(body);
  if (markdown instanceof Response) {
    await recordAudit(deps, {
      actor,
      action: "workflow.update",
      targetId: name,
      result: "error",
      error: "invalid markdown",
    });
    return markdown;
  }
  if (!WORKFLOW_NAME_RE.test(name)) {
    return Response.json({ error: "invalid workflow name" }, { status: 400 });
  }

  const projectRoot = deps.projectRoot ?? process.cwd();
  const definition = deps.registry.get(name);
  const disk = await readWorkflowDisk(name, definition, projectRoot);
  const validateOnly = new URL(req.url).searchParams.get("validate") === "1";
  if (!definition && !disk && !validateOnly) {
    await recordAudit(deps, {
      actor,
      action: "workflow.update",
      targetId: name,
      result: "error",
      error: "not found",
    });
    return Response.json({ error: "not found" }, { status: 404 });
  }

  const requestedRoot = body.sourceRoot === "overlay" || body.sourceRoot === "public"
    ? body.sourceRoot
    : null;
  const sourceRoot = disk?.sourceRoot ?? definition?.sourceRoot ?? requestedRoot ?? "public";
  const sourcePath = disk?.sourcePath ??
    (sourceRoot === "overlay"
      ? join(OVERLAY_WORKFLOW_ROOT, `${name}.workflow.md`)
      : join(PUBLIC_WORKFLOW_ROOT, `${name}.workflow.md`));
  const fileVersionHash = disk ? hashWorkflowContent(disk.markdown) : "";
  const ctx = validationContext(deps);

  const validated = tryValidateMarkdown({
    markdown,
    path: sourcePath,
    sourceRoot,
    repos: ctx.repos,
    builtInCommands: ctx.builtInCommands,
  });
  if (validated instanceof Response) {
    await recordAudit(deps, {
      actor,
      action: "workflow.update",
      targetId: name,
      result: "error",
      error: "invalid workflow",
    });
    return validated;
  }
  if (validated.name !== name) {
    return invalidWorkflowResponse(
      new Error(`Workflow name "${validated.name}" must match filename "${name}"`),
      sourcePath,
    );
  }

  if (validateOnly) {
    return Response.json({
      valid: true,
      name,
      versionHash: hashWorkflowContent(markdown),
      sourceRoot,
      sourcePath,
    });
  }

  const expected = body.expectedVersionHash;
  if (typeof expected !== "string" || !expected) {
    await recordAudit(deps, {
      actor,
      action: "workflow.update",
      targetId: name,
      result: "error",
      error: "expectedVersionHash is required",
    });
    return Response.json({ error: "expectedVersionHash is required" }, { status: 400 });
  }
  if (expected !== fileVersionHash) {
    await recordAudit(deps, {
      actor,
      action: "workflow.update",
      targetId: name,
      result: "error",
      error: "version hash mismatch",
    });
    return Response.json(
      { error: "version hash mismatch", fileVersionHash },
      { status: 409 },
    );
  }

  const commitHereAnyway = body.commitHereAnyway === true;
  const blocked = await gitWriteBlocked({
    projectRoot,
    sourceRoot,
    commitHereAnyway,
  });
  if (blocked) {
    await recordAudit(deps, {
      actor,
      action: "workflow.update",
      targetId: name,
      result: "error",
      error: blocked.error,
    });
    return Response.json(blocked, { status: 409 });
  }

  return commitWorkflowMutation({
    deps,
    actor,
    action: "workflow.update",
    kind: "update",
    name,
    markdown,
    sourceRoot,
    sourcePath,
    commitMessage: readOptionalString(body.commitMessage),
    status: 200,
    definition: validated,
    expectedVersionHash: expected,
  });
}

export async function handleWorkflowCreate(
  req: Request,
  deps: WorkflowRouteDeps,
): Promise<Response> {
  const actorGate = await requireWriteActor(deps, {
    action: "workflow.create",
    targetId: "new",
  });
  if (actorGate instanceof Response) return actorGate;
  const { actor } = actorGate;

  const body = await readJsonObject(req);
  if (body instanceof Response) {
    await recordAudit(deps, {
      actor,
      action: "workflow.create",
      targetId: "new",
      result: "error",
      error: "invalid json",
    });
    return body;
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!WORKFLOW_NAME_RE.test(name)) {
    await recordAudit(deps, {
      actor,
      action: "workflow.create",
      targetId: name || "new",
      result: "error",
      error: "invalid workflow name",
    });
    return Response.json({ error: "invalid workflow name" }, { status: 400 });
  }
  const sourceRoot = body.sourceRoot;
  if (sourceRoot !== "public" && sourceRoot !== "overlay") {
    await recordAudit(deps, {
      actor,
      action: "workflow.create",
      targetId: name,
      result: "error",
      error: "sourceRoot is required",
    });
    return Response.json({ error: "sourceRoot is required" }, { status: 400 });
  }

  const markdown = readMarkdown(body);
  if (markdown instanceof Response) {
    await recordAudit(deps, {
      actor,
      action: "workflow.create",
      targetId: name,
      result: "error",
      error: "invalid markdown",
    });
    return markdown;
  }

  const projectRoot = deps.projectRoot ?? process.cwd();
  if (sourceRoot === "overlay" && !existsSync(join(projectRoot, "agents-org"))) {
    await recordAudit(deps, {
      actor,
      action: "workflow.create",
      targetId: name,
      result: "error",
      error: "overlay root missing",
    });
    return Response.json({ error: "overlay root missing" }, { status: 400 });
  }

  const overlayRel = join(OVERLAY_WORKFLOW_ROOT, `${name}.workflow.md`);
  const publicRel = join(PUBLIC_WORKFLOW_ROOT, `${name}.workflow.md`);
  const earlyCollision = createCollision(projectRoot, name, sourceRoot);
  if (earlyCollision) {
    await recordAudit(deps, {
      actor,
      action: "workflow.create",
      targetId: name,
      result: "error",
      error: earlyCollision.error,
    });
    return Response.json({ error: earlyCollision.error }, { status: 409 });
  }
  const sourcePath = sourceRoot === "overlay" ? overlayRel : publicRel;
  const ctx = validationContext(deps);
  const validated = tryValidateMarkdown({
    markdown,
    path: sourcePath,
    sourceRoot,
    repos: ctx.repos,
    builtInCommands: ctx.builtInCommands,
  });
  if (validated instanceof Response) {
    await recordAudit(deps, {
      actor,
      action: "workflow.create",
      targetId: name,
      result: "error",
      error: "invalid workflow",
    });
    return validated;
  }
  if (validated.name !== name) {
    return invalidWorkflowResponse(
      new Error(`Workflow name "${validated.name}" must match filename "${name}"`),
      sourcePath,
    );
  }

  const commitHereAnyway = body.commitHereAnyway === true;
  const blocked = await gitWriteBlocked({
    projectRoot,
    sourceRoot,
    commitHereAnyway,
  });
  if (blocked) {
    await recordAudit(deps, {
      actor,
      action: "workflow.create",
      targetId: name,
      result: "error",
      error: blocked.error,
    });
    return Response.json(blocked, { status: 409 });
  }

  return commitWorkflowMutation({
    deps,
    actor,
    action: "workflow.create",
    kind: "create",
    name,
    markdown,
    sourceRoot,
    sourcePath,
    commitMessage: readOptionalString(body.commitMessage),
    status: 201,
    definition: validated,
    expectedVersionHash: "",
  });
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

async function requireWriteActor(
  deps: WorkflowRouteDeps,
  input: { action: string; targetId: string },
): Promise<{ actor: string } | Response> {
  const actorGate = await requireDashboardActor(deps, input);
  if (actorGate instanceof Response) return actorGate;
  const { actor } = actorGate;
  if (await deps.sessionManager.isExplicitAdmin(actor)) return { actor };
  if (await deps.sessionManager.isAdmin(actor)) return { actor };
  return deny(deps, { actor, action: input.action, targetId: input.targetId });
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
    commitSha?: string | null;
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
    commitSha: input.commitSha ?? null,
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

async function probeWorkflowGitDetail(
  disk: {
    sourcePath: string;
    sourceRoot: WorkflowSourceRoot;
    absolutePath: string;
  } | null,
  sourceRoot: WorkflowSourceRoot,
  projectRoot: string,
): Promise<WorkflowGitStatus & { parent?: WorkflowGitStatus }> {
  const empty: WorkflowGitStatus = {
    sha: null,
    branch: null,
    detached: false,
    dirty: false,
    merging: false,
    rebasing: false,
  };
  const repoRoot = disk
    ? existingRealpath(dirname(disk.absolutePath) === disk.absolutePath
      ? disk.absolutePath
      : resolve(disk.absolutePath, ".."))
    : sourceRoot === "overlay"
    ? join(projectRoot, "agents-org")
    : projectRoot;
  const fileRepo = disk
    ? await probeFileRepo(disk.absolutePath, projectRoot)
    : await probeWorkflowRepo(repoRoot);
  if (sourceRoot === "overlay") {
    return {
      ...fileRepo,
      parent: await probeWorkflowRepo(projectRoot),
    };
  }
  return fileRepo.sha || fileRepo.branch || fileRepo.detached || fileRepo.merging
    ? fileRepo
    : empty;
}

async function probeFileRepo(
  absolutePath: string,
  projectRoot: string,
): Promise<WorkflowGitStatus> {
  const empty: WorkflowGitStatus = {
    sha: null,
    branch: null,
    detached: false,
    dirty: false,
    merging: false,
    rebasing: false,
  };
  if (!absolutePath) return empty;
  try {
    const abs = existingRealpath(absolutePath);
    const toplevel = existingRealpath(
      (await git(dirname(abs), ["rev-parse", "--show-toplevel"])).trim(),
    );
    const rel = relative(toplevel, abs).replaceAll("\\", "/");
    return await probeWorkflowRepo(toplevel, rel);
  } catch {
    return probeWorkflowRepo(projectRoot);
  }
}

async function gitWriteBlocked(input: {
  projectRoot: string;
  sourceRoot: WorkflowSourceRoot;
  commitHereAnyway: boolean;
}): Promise<{ error: string; repo: string; git?: WorkflowGitStatus; branch?: string | null } | null> {
  const junior = await probeWorkflowRepo(input.projectRoot);
  const overlay = input.sourceRoot === "overlay"
    ? await probeWorkflowRepo(join(input.projectRoot, "agents-org"))
    : null;
  const repos: Array<{ git: WorkflowGitStatus; repo: string }> = [
    {
      git: overlay ?? junior,
      repo: overlay ? "agents-org" : "junior",
    },
  ];
  if (overlay) repos.push({ git: junior, repo: "junior" });
  for (const item of repos) {
    if (item.git.detached) {
      return { error: "detached-head", repo: item.repo, git: item.git };
    }
    if (item.git.merging) {
      return { error: "merging", repo: item.repo, git: item.git };
    }
    if (item.git.rebasing) {
      return { error: "rebasing", repo: item.repo, git: item.git };
    }
    if (!isProtectedBranch(item.git.branch) && !input.commitHereAnyway) {
      return {
        error: "commit here anyway required",
        branch: item.git.branch,
        repo: item.repo,
      };
    }
  }
  return null;
}

async function commitWorkflowMutation(input: {
  deps: WorkflowRouteDeps;
  actor: string;
  action: "workflow.create" | "workflow.update";
  kind: "create" | "update";
  name: string;
  markdown: string;
  sourceRoot: WorkflowSourceRoot;
  sourcePath: string;
  commitMessage: string | undefined;
  status: number;
  definition: WorkflowDefinition;
  expectedVersionHash?: string;
}): Promise<Response> {
  const projectRoot = input.deps.projectRoot ?? process.cwd();
  const ctx = validationContext(input.deps);
  const run = async () => {
    input.deps.registry.pauseReloads();
    let restoreFailed = false;
    try {
      if (input.kind === "create") {
        const collision = createCollision(
          projectRoot,
          input.name,
          input.sourceRoot,
        );
        if (collision) {
          await recordAudit(input.deps, {
            actor: input.actor,
            action: input.action,
            targetId: input.name,
            request: { sourceRoot: input.sourceRoot },
            result: "error",
            error: collision.error,
          });
          return Response.json({ error: collision.error }, { status: 409 });
        }
      }
      const result = await writeDashboardWorkflow({
        projectRoot,
        sourceRoot: input.sourceRoot,
        name: input.name,
        markdown: input.markdown,
        message: defaultWorkflowCommitMessage({
          kind: input.kind,
          name: input.name,
          sourceRoot: input.sourceRoot,
          sourcePath: input.sourcePath,
          actor: input.actor,
          commitMessage: input.commitMessage,
        }),
        actor: input.actor,
        repos: ctx.repos,
        builtInCommands: ctx.builtInCommands,
        expectedVersionHash: input.expectedVersionHash,
      });
      if (!result.ok) {
        restoreFailed = result.code === "restore-failed";
        if (result.code === "version-hash-mismatch" && input.kind === "create") {
          await recordAudit(input.deps, {
            actor: input.actor,
            action: input.action,
            targetId: input.name,
            request: { sourceRoot: input.sourceRoot },
            result: "error",
            error: "workflow already exists",
          });
          return Response.json({ error: "workflow already exists" }, { status: 409 });
        }
        if (result.code === "invalid-workflow") {
          await recordAudit(input.deps, {
            actor: input.actor,
            action: input.action,
            targetId: input.name,
            request: { sourceRoot: input.sourceRoot },
            result: "error",
            error: "invalid workflow",
          });
          return invalidWorkflowResponse(new Error(result.detail), input.sourcePath);
        }
        const status = result.code === "overlay-root-missing" ||
            result.code === "not-a-repo" ||
            result.code === "path-outside-repo"
          ? 400
          : 409;
        await recordAudit(input.deps, {
          actor: input.actor,
          action: input.action,
          targetId: input.name,
          request: { sourceRoot: input.sourceRoot },
          result: "error",
          error: result.code,
        });
        return Response.json(
          { error: result.code, detail: result.detail },
          { status },
        );
      }

    const slackTs = await postWorkflowNotice(
      input.deps,
      input.definition,
      input.kind === "create" ? "created" : "updated",
      input.actor,
    );
    const parentFailed = result.overlayCommitted &&
      result.parentPointerCommitted === false;
    await recordAudit(input.deps, {
      actor: input.actor,
      action: input.action,
      targetId: input.name,
      request: {
        sourceRoot: input.sourceRoot,
        sourcePath: result.sourcePath,
      },
      result: parentFailed ? "partial" : "ok",
      slackTs,
      commitSha: result.commit.sha,
      error: parentFailed && result.parentPointer && "code" in result.parentPointer
        ? result.parentPointer.detail
        : null,
    });
    log.info(
      "dashboard",
      `dashboard action=${input.action} name=${input.name} result=${parentFailed ? "partial" : "ok"}`,
    );
      return Response.json({
        name: result.name,
        sourcePath: result.sourcePath,
        sourceRoot: result.sourceRoot,
        versionHash: result.versionHash,
        overlayCommitted: result.overlayCommitted,
        commit: result.commit,
        parentPointerCommitted: result.parentPointerCommitted,
        parentPointer: result.parentPointer,
      }, { status: input.status });
    } finally {
      await input.deps.registry.resumeReloads({ reload: !restoreFailed });
    }
  };
  if (typeof input.deps.registry.withWriteLock === "function") {
    return input.deps.registry.withWriteLock(run);
  }
  return run();
}

function tryValidateMarkdown(input: {
  markdown: string;
  path: string;
  sourceRoot: WorkflowSourceRoot;
  repos: RepoConfig[];
  builtInCommands: Set<string>;
}): WorkflowDefinition | Response {
  try {
    return validateWorkflowMarkdown(input);
  } catch (err) {
    return invalidWorkflowResponse(err, input.path);
  }
}

function invalidWorkflowResponse(err: unknown, path: string): Response {
  return Response.json(
    {
      error: "invalid workflow",
      errors: [{ path, message: formatError(err) }],
    },
    { status: 400 },
  );
}

function validationContext(deps: WorkflowRouteDeps): {
  repos: RepoConfig[];
  builtInCommands: Set<string>;
} {
  if (typeof deps.registry.validationContext === "function") {
    return deps.registry.validationContext();
  }
  return { repos: deps.repos ?? [], builtInCommands: new Set() };
}

function readMarkdown(body: Record<string, unknown>): string | Response {
  if (typeof body.markdown !== "string") {
    return Response.json({ error: "markdown must be a string" }, { status: 400 });
  }
  return body.markdown;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function createCollision(
  projectRoot: string,
  name: string,
  sourceRoot: WorkflowSourceRoot,
): { error: string } | null {
  const overlayExists = existsSync(
    join(projectRoot, OVERLAY_WORKFLOW_ROOT, `${name}.workflow.md`),
  );
  const publicExists = existsSync(
    join(projectRoot, PUBLIC_WORKFLOW_ROOT, `${name}.workflow.md`),
  );
  if (sourceRoot === "public" && overlayExists) {
    return { error: "overlay shadows this name" };
  }
  if (
    (sourceRoot === "public" && publicExists) ||
    (sourceRoot === "overlay" && overlayExists)
  ) {
    return { error: "workflow already exists" };
  }
  return null;
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
