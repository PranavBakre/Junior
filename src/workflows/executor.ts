import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { WebClient } from "@slack/web-api";
import type { Config, RepoConfig } from "../config.ts";
import { spawnRunner } from "../runners/index.ts";
import type { RunnerEvent, SpawnHandle, SpawnRunnerFn } from "../runners/types.ts";
import { createSession, type ImplementedRunnerProvider } from "../session/types.ts";
import { withTimeout } from "../lifecycle/timeout.ts";
import { log } from "../logger.ts";
import type {
  WorkflowDefinition,
  WorkflowOutput,
  WorkflowRunnerConfig,
  WorkflowRun,
  WorkflowRunReason,
} from "./types.ts";
import {
  WORKFLOW_ARTIFACT_ROOT,
} from "./types.ts";
import type { WorkflowStore } from "./store.ts";
import type { MemoryStore } from "../memory/store.ts";
import {
  runConsolidationSweep,
  summarizeConsolidationSweep,
} from "../memory/consolidation/index.ts";
import { createRunnerInvoke } from "../memory/consolidation/runner.ts";
import { createProfileStore } from "../memory/profiles/factory.ts";
import type { ProfileStore } from "../memory/profiles/store.ts";
import type { EmbeddingProvider } from "../memory/embedding/types.ts";
import type { ConsolidationInvoke } from "../memory/consolidation/types.ts";

export const WORKFLOW_UTILITY_CWD = "/tmp/junior-utility";
const DEFAULT_MAX_IDLE_INTERRUPTS = 3;

export interface WorkflowExecutorOptions {
  config: Config;
  store: WorkflowStore;
  slackClient?: WebClient;
  spawn?: SpawnRunnerFn;
  now?: () => Date;
  memoryStore?: MemoryStore;
  /**
   * v3 consolidation dependencies for the memory-consolidation workflow. Tests
   * inject a fake invoke + hashing embedder + temp profile store; production
   * leaves these undefined and they are built lazily (the local embedder loads a
   * ~270MB model, so it must NEVER be constructed unless the workflow actually runs).
   */
  consolidationDeps?: {
    profileStore?: ProfileStore;
    embedder?: EmbeddingProvider;
    invoke?: ConsolidationInvoke;
  };
}

export interface WorkflowRunRequest {
  definition: WorkflowDefinition;
  reason: WorkflowRunReason;
  actorSlackUserId?: string | null;
}

export interface WorkflowRunResult {
  run: WorkflowRun;
  summary: string;
}

export class WorkflowExecutor {
  private config: Config;
  private store: WorkflowStore;
  private slackClient?: WebClient;
  private spawn: SpawnRunnerFn;
  private now: () => Date;
  private memoryStore?: MemoryStore;
  private consolidationDeps?: WorkflowExecutorOptions["consolidationDeps"];
  private activeHandles = new Set<SpawnHandle>();

  constructor(options: WorkflowExecutorOptions) {
    this.config = options.config;
    this.store = options.store;
    this.slackClient = options.slackClient;
    this.spawn = options.spawn ?? spawnRunner;
    this.now = options.now ?? (() => new Date());
    this.memoryStore = options.memoryStore;
    this.consolidationDeps = options.consolidationDeps;
  }

  async run(request: WorkflowRunRequest): Promise<WorkflowRunResult> {
    const started = this.now();
    const runId = `${request.definition.name}-${started.toISOString().replace(/[:.]/g, "-")}`;
    const artifactPath = artifactPathFor(request.definition, started, runId);
    const run: WorkflowRun = {
      id: runId,
      workflowName: request.definition.name,
      workflowVersionHash: request.definition.versionHash,
      sourcePath: request.definition.sourcePath,
      reason: request.reason,
      actorSlackUserId: request.actorSlackUserId ?? null,
      status: "running",
      startedAt: started.getTime(),
      finishedAt: null,
      artifactPath,
      providerSessionId: null,
      slackChannel: null,
      slackThreadTs: null,
      error: null,
    };
    await this.store.createRun(run);

    let summary = "";
    try {
      if (request.definition.name === "memory-consolidation" && this.memoryStore) {
        // v3 sweep-only. The consolidation sweep IS the LLM pass — it spawns the
        // runner per session to derive episodes/profiles/claims (memory v3 §7).
        // A second inspection-agent pass on top would double the LLM cost and
        // run a prompt still written for the retired deterministic consolidate().
        // The sweep's own summary is the workflow artifact.
        summary = await this.runMemoryConsolidation();
      } else if (request.definition.runner) {
        summary = await this.runWithRunner(
          request.definition,
          run,
          buildRunnerPromptWithNative({
            definition: request.definition,
            run,
            repos: this.reposFor(request.definition),
            nativeResult: null,
          }),
        );
      } else {
        summary = request.definition.prompt.trim() ||
          `Workflow ${request.definition.name} ran.`;
      }

      run.status = "success";
      run.finishedAt = this.now().getTime();
      const body = renderArtifact({
        definition: request.definition,
        run,
        summary,
      });
      await writeArtifact(artifactPath, body);
      const slackMeta = await this.emitOutputs(request.definition, summary);
      run.slackChannel = slackMeta.channel;
      run.slackThreadTs = slackMeta.threadTs;
      await this.store.updateRun(run);
      await this.updateStateAfterRun(request.definition, run);
      return { run, summary };
    } catch (err) {
      run.status = "failed";
      run.error = err instanceof Error ? err.message : String(err);
      run.finishedAt = this.now().getTime();
      const failureBody = renderArtifact({
        definition: request.definition,
        run,
        summary: summary || "_Workflow failed before summary generation._",
      });
      await writeArtifact(artifactPath, failureBody).catch(() => undefined);
      await this.store.updateRun(run);
      await this.updateStateAfterRun(request.definition, run);
      throw err;
    }
  }

  async terminateActiveRuns(): Promise<void> {
    const handles = [...this.activeHandles];
    for (const handle of handles) {
      handle.kill("SIGINT");
    }
    await Promise.race([
      Promise.allSettled(handles.map((handle) => handle.result)),
      new Promise((resolve) => setTimeout(resolve, 10_000)),
    ]);
    for (const handle of handles) {
      if (!this.activeHandles.has(handle)) continue;
      handle.kill("SIGKILL");
      this.activeHandles.delete(handle);
    }
  }

  private async runWithRunner(
    definition: WorkflowDefinition,
    run: WorkflowRun,
    prompt: string,
  ): Promise<string> {
    const runner = definition.runner;
    if (!runner) throw new Error(`Workflow ${definition.name} has no runner`);
    const provider: ImplementedRunnerProvider =
      runner.provider === "default" ? this.config.runner.provider : runner.provider;
    const session = createSession(
      `workflow-${definition.name}`,
      "workflow",
      "quiet",
      provider,
      this.config.claude.defaultDriver,
    );
    session.cwd = WORKFLOW_UTILITY_CWD;
    session.agentType = runner.agentName;
    session.activeAgentName = runner.agentName;
    session.model = runner.model ?? null;
    session.systemPrompt = [
      "You are executing a Junior workflow from a markdown workflow definition.",
      "Use the provided workflow instructions and runtime context as the source of truth.",
      "Use only capabilities declared in the workflow permissions.",
      "Return the final workflow result as Slack mrkdwn.",
      "Junior will write your final response to configured docs outputs and post it to configured Slack outputs.",
    ].join("\n\n");

    return await this.runWorkflowRunnerAttempts({
      definition,
      run,
      runner,
      provider,
      session,
      initialPrompt: prompt,
    });
  }

  private async runWorkflowRunnerAttempts(options: {
    definition: WorkflowDefinition;
    run: WorkflowRun;
    runner: WorkflowRunnerConfig;
    provider: ImplementedRunnerProvider;
    session: ReturnType<typeof createSession>;
    initialPrompt: string;
  }): Promise<string> {
    const idleResumeEnabled = this.idleResumeEnabled(options.provider);
    const maxIdleInterrupts = options.runner.idleTimeoutMs && idleResumeEnabled
      ? (options.runner.maxIdleInterrupts ?? DEFAULT_MAX_IDLE_INTERRUPTS)
      : 0;
    let idleInterrupts = 0;
    let prompt = options.initialPrompt;

    for (;;) {
      const attempt = await this.runWorkflowRunnerAttempt({
        ...options,
        prompt,
        idleResumeEnabled,
      });
      if (attempt.result.sessionId) {
        options.session.sessionId = attempt.result.sessionId;
      }
      if (attempt.result.exitCode === 0 && !attempt.result.error) {
        const response = attempt.result.response.trim();
        if (!response) throw new Error("Workflow runner returned an empty response");
        return response;
      }

      if (
        attempt.idleInterrupted &&
        idleResumeEnabled &&
        options.session.sessionId &&
        idleInterrupts < maxIdleInterrupts
      ) {
        idleInterrupts += 1;
        log.warn(
          "workflow",
          `runner idle-interrupted workflow=${options.definition.name} run=${options.run.id} count=${idleInterrupts}`,
        );
        prompt = buildIdleContinuePrompt(
          options.runner.idleTimeoutMs!,
          idleInterrupts,
          maxIdleInterrupts,
        );
        continue;
      }

      log.warn(
        "workflow",
        `runner failed workflow=${options.definition.name}: ${attempt.result.error ?? attempt.result.exitCode}`,
      );
      throw new Error(
        `Workflow runner failed: ${attempt.result.error ?? `exit ${attempt.result.exitCode}`}`,
      );
    }
  }

  private async runWorkflowRunnerAttempt(options: {
    definition: WorkflowDefinition;
    run: WorkflowRun;
    runner: WorkflowRunnerConfig;
    provider: ImplementedRunnerProvider;
    session: ReturnType<typeof createSession>;
    prompt: string;
    idleResumeEnabled: boolean;
  }): Promise<{ result: Awaited<SpawnHandle["result"]>; idleInterrupted: boolean }> {
    const handle = this.spawn(
      options.session,
      options.prompt,
      this.config,
    );
    this.activeHandles.add(handle);
    let idleInterrupted = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let idleKillTimer: ReturnType<typeof setTimeout> | null = null;
    const clearIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (idleKillTimer) clearTimeout(idleKillTimer);
      idleTimer = null;
      idleKillTimer = null;
    };
    const armIdleTimer = () => {
      clearIdleTimer();
      if (!options.idleResumeEnabled || !options.runner.idleTimeoutMs) return;
      idleTimer = setTimeout(() => {
        idleInterrupted = true;
        log.warn(
          "workflow",
          `idle-interrupt workflow=${options.definition.name} run=${options.run.id}`,
        );
        handle.kill("SIGINT");
        idleKillTimer = setTimeout(() => {
          log.warn(
            "workflow",
            `idle-escalate workflow=${options.definition.name} run=${options.run.id}`,
          );
          handle.kill("SIGKILL");
        }, 10_000);
      }, options.runner.idleTimeoutMs);
    };

    armIdleTimer();
    handle.onEvent((event) => {
      armIdleTimer();
      if (event.type === "init") {
        options.session.sessionId = event.sessionId;
        options.run.providerSessionId = event.sessionId;
        void this.store.updateRun(options.run).catch((err) => {
          log.warn(
            "workflow",
            `session id persist failed workflow=${options.definition.name} run=${options.run.id}: ${formatError(err)}`,
          );
        });
      }
      logWorkflowRunnerEvent(options.definition.name, options.run.id, event);
    });

    const bounded = withTimeout(
      handle,
      options.runner.timeoutMs ?? this.timeoutFor(options.provider),
      () => handle.kill(),
    );
    const result = await bounded.result.finally(() => {
      clearIdleTimer();
      this.activeHandles.delete(handle);
    });
    return { result, idleInterrupted };
  }

  private idleResumeEnabled(provider: ImplementedRunnerProvider): boolean {
    if (provider === "opencode") return this.config.opencode.continuityEnabled;
    return provider !== "opencode-sdk" && provider !== "codex-app-server";
  }

  private async emitOutputs(
    definition: WorkflowDefinition,
    summary: string,
  ): Promise<{ channel: string | null; threadTs: string | null }> {
    let slackChannel: string | null = null;
    let slackThreadTs: string | null = null;
    for (const output of definition.outputs) {
      if (output.type === "docs") continue;
      if (!this.slackClient) continue;
      const posted = await this.postSlack(output, summary);
      slackChannel = posted.channel;
      slackThreadTs = posted.threadTs;
    }
    return { channel: slackChannel, threadTs: slackThreadTs };
  }

  private async runMemoryConsolidation(): Promise<string> {
    if (!this.memoryStore) throw new Error("memory store not configured");
    // v3 offline write path (memory v3 §7): drain unconsolidated source records,
    // session-scoped per thread plus a final unthreaded sweep, persisting episodes
    // / profiles / claims through the gates. The legacy deterministic
    // `memoryStore.consolidate()` is intentionally no longer called here.
    const profileStore = this.consolidationDeps?.profileStore ?? createProfileStore();
    const embedder = this.consolidationDeps?.embedder ?? (await loadLocalEmbedder());
    const invoke = this.consolidationDeps?.invoke ?? createRunnerInvoke({});

    const reports = await runConsolidationSweep({
      store: this.memoryStore,
      profileStore,
      embedder,
      invoke,
    });
    return summarizeConsolidationSweep(reports);
  }

  private async postSlack(
    output: Exclude<WorkflowOutput, { type: "docs" }>,
    text: string,
  ): Promise<{ channel: string; threadTs: string | null }> {
    if (!this.slackClient) return { channel: "", threadTs: null };
    if (output.type === "slack") {
      const result = await this.slackClient.chat.postMessage({
        channel: output.channel,
        text,
        ...(output.threadTs ? { thread_ts: output.threadTs } : {}),
      });
      return {
        channel: output.channel,
        threadTs: output.threadTs ?? result.ts ?? null,
      };
    }
    const result = await this.slackClient.chat.postMessage({
      channel: output.channel,
      text,
    });
    return { channel: output.channel, threadTs: result.ts ?? null };
  }

  private reposFor(definition: WorkflowDefinition): RepoConfig[] {
    if (!definition.permissions.repos) return this.config.repos;
    const permitted = new Set(definition.permissions.repos ?? []);
    return this.config.repos.filter((repo) => permitted.has(repo.name));
  }

  private timeoutFor(provider: ImplementedRunnerProvider): number {
    if (provider === "codex-app-server") return this.config.codex.timeoutMs;
    return provider === "opencode" || provider === "opencode-sdk"
      ? this.config.opencode.timeoutMs
      : this.config.claude.timeoutMs;
  }

  private async updateStateAfterRun(
    definition: WorkflowDefinition,
    run: WorkflowRun,
  ): Promise<void> {
    const state = await this.store.getState(definition.name);
    await this.store.setState({
      name: definition.name,
      status: state?.status ?? (definition.enabled ? "active" : "stopped"),
      activeVersionHash: definition.versionHash,
      sourcePath: definition.sourcePath,
      lastLoadedAt: state?.lastLoadedAt ?? this.now().getTime(),
      nextRunAt: state?.nextRunAt ?? null,
      lastRunAt: run.finishedAt,
      lastRunStatus: run.status === "running" ? null : run.status,
      lastError: run.error,
    });
  }
}

/**
 * Build the production local embedder lazily. The embedding factory's static graph
 * pulls @huggingface/transformers (~270MB), so it is dynamically imported only when
 * the memory-consolidation workflow actually runs — never at executor construction.
 */
async function loadLocalEmbedder(): Promise<EmbeddingProvider> {
  const { createEmbeddingProvider } = await import("../memory/embedding/factory.ts");
  return createEmbeddingProvider("local");
}

function artifactPathFor(definition: WorkflowDefinition, started: Date, runId: string): string {
  const date = started.toISOString().slice(0, 10);
  const docsOutput = definition.outputs.find((output) => output.type === "docs");
  const root = docsOutput?.path ?? join(WORKFLOW_ARTIFACT_ROOT, definition.name);
  return join(root, `${date}-${runId}.md`);
}

async function writeArtifact(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

function renderArtifact(options: {
  definition: WorkflowDefinition;
  run: WorkflowRun;
  summary: string;
}): string {
  return [
    `# Workflow Run: ${options.definition.name}`,
    "",
    `Run ID: ${options.run.id}`,
    `Workflow version: ${options.definition.versionHash}`,
    `Source: ${options.definition.sourcePath}`,
    `Reason: ${options.run.reason}`,
    `Actor: ${options.run.actorSlackUserId ?? "system"}`,
    `Status: ${options.run.status}`,
    options.run.providerSessionId ? `Provider session: ${options.run.providerSessionId}` : null,
    options.run.error ? `Error: ${options.run.error}` : null,
    "",
    "## Final Summary",
    "",
    options.summary,
    "",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

function buildRunnerPromptWithNative(options: {
  definition: WorkflowDefinition;
  run: WorkflowRun;
  repos: RepoConfig[];
  nativeResult: string | null;
}): string {
  const parts = [
    `Run workflow: ${options.definition.name}`,
    "",
    "Workflow prompt:",
    options.definition.prompt.trim() || "(empty)",
    "",
  ];

  if (options.nativeResult) {
    parts.push(
      "The v3 consolidation engine has already run over the unconsolidated source records",
      "(session-scoped per thread, plus a final unthreaded sweep) and written episodes,",
      "profiles, and claims through the v3 gates. Here is what it wrote:",
      "",
      "```",
      options.nativeResult,
      "```",
      "",
      "Your job: inspect the current memory state via the memory tools, sanity-check the newly written episodes/profiles/claims, surface anything that looks wrong or duplicated, and produce a final human-readable summary. Do not re-run consolidation — it's already done. Focus on inspection, validation, and explanation.",
      "",
    );
  }

  parts.push(
    "Runtime context:",
    JSON.stringify({
      run: {
        id: options.run.id,
        reason: options.run.reason,
        artifactPath: options.run.artifactPath,
      },
      workflow: {
        name: options.definition.name,
        description: options.definition.description ?? null,
        permissions: options.definition.permissions,
        outputs: options.definition.outputs,
      },
      junior: {
        projectRoot: process.cwd(),
        memoryCli: join(process.cwd(), "src/memory/cli.ts"),
      },
      repos: options.repos.map((repo) => ({
        name: repo.name,
        path: repo.path,
        defaultBase: repo.defaultBase,
      })),
    }, null, 2),
    "",
    "Final response requirements:",
    "- Produce the final Slack-ready workflow result.",
    "- Include collection or execution errors only when they affect trust in the result.",
    "- Do not say you cannot access repos without first using the provided absolute repo paths.",
  );

  return parts.join("\n");
}

function buildIdleContinuePrompt(
  idleTimeoutMs: number,
  interruptCount: number,
  maxInterrupts: number,
): string {
  return [
    `The previous workflow runner process was interrupted after ${idleTimeoutMs}ms with no runner events.`,
    `Idle interrupt ${interruptCount} of ${maxInterrupts}.`,
    "Resume the existing workflow session and continue from the last completed step.",
    "Do not restart deterministic work that has already completed unless required to recover.",
    "When finished, return the final Slack-ready workflow result.",
  ].join("\n");
}

function logWorkflowRunnerEvent(
  workflowName: string,
  runId: string,
  event: RunnerEvent,
): void {
  const prefix = `workflow=${workflowName} run=${runId} provider=${event.provider}`;
  if (event.type === "init") {
    log.info("workflow-runner", `${prefix} sessionId=${event.sessionId} init`);
    return;
  }
  if (event.type === "tool") {
    log.info(
      "workflow-runner",
      `${prefix} tool=${event.name} status=${event.status ?? "unknown"}`,
    );
    return;
  }
  if (event.type === "message") {
    log.info(
      "workflow-runner",
      `${prefix} message len=${event.text.length}`,
    );
    return;
  }
  if (event.type === "done") {
    log.info("workflow-runner", `${prefix} done`);
  }
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
