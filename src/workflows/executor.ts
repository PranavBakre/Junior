import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { WebClient } from "@slack/web-api";
import type { Config, RepoConfig } from "../config.ts";
import { spawnRunner } from "../runners/index.ts";
import type { RunnerEvent, SpawnRunnerFn } from "../runners/types.ts";
import { createSession, type ImplementedRunnerProvider } from "../session/types.ts";
import { withTimeout } from "../lifecycle/timeout.ts";
import { log } from "../logger.ts";
import type {
  WorkflowDefinition,
  WorkflowOutput,
  WorkflowRun,
  WorkflowRunReason,
} from "./types.ts";
import {
  WORKFLOW_ARTIFACT_ROOT,
} from "./types.ts";
import type { WorkflowStore } from "./store.ts";

export const WORKFLOW_UTILITY_CWD = "/tmp/junior-utility";

export interface WorkflowExecutorOptions {
  config: Config;
  store: WorkflowStore;
  slackClient?: WebClient;
  spawn?: SpawnRunnerFn;
  now?: () => Date;
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

  constructor(options: WorkflowExecutorOptions) {
    this.config = options.config;
    this.store = options.store;
    this.slackClient = options.slackClient;
    this.spawn = options.spawn ?? spawnRunner;
    this.now = options.now ?? (() => new Date());
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
      if (request.definition.runner) {
        summary = await this.runWithRunner(
          request.definition,
          run,
          buildRunnerPrompt({
            definition: request.definition,
            run,
            repos: this.reposFor(request.definition),
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

    const handle = this.spawn(
      session,
      prompt,
      this.config,
    );
    handle.onEvent((event) => {
      if (event.type === "init") {
        run.providerSessionId = event.sessionId;
        void this.store.updateRun(run).catch((err) => {
          log.warn(
            "workflow",
            `session id persist failed workflow=${definition.name} run=${run.id}: ${formatError(err)}`,
          );
        });
      }
      logWorkflowRunnerEvent(definition.name, run.id, event);
    });
    const bounded = withTimeout(
      handle,
      runner.timeoutMs ?? this.timeoutFor(provider),
      () => handle.kill(),
    );
    const result = await bounded.result;
    if (result.exitCode !== 0 || result.error) {
      log.warn("workflow", `runner failed workflow=${definition.name}: ${result.error ?? result.exitCode}`);
      throw new Error(
        `Workflow runner failed: ${result.error ?? `exit ${result.exitCode}`}`,
      );
    }
    const response = result.response.trim();
    if (!response) throw new Error("Workflow runner returned an empty response");
    return response;
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
    return provider === "opencode"
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

function buildRunnerPrompt(options: {
  definition: WorkflowDefinition;
  run: WorkflowRun;
  repos: RepoConfig[];
}): string {
  return [
    `Run workflow: ${options.definition.name}`,
    "",
    "Workflow prompt:",
    options.definition.prompt.trim() || "(empty)",
    "",
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
