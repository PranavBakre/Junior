import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { WebClient } from "@slack/web-api";
import type { Config, RepoConfig } from "../config.ts";
import { spawnRunner } from "../runners/index.ts";
import type { SpawnRunnerFn } from "../runners/types.ts";
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
import {
  collectWorklogActivity,
  formatWorklogSlackSummary,
  renderWorklogArtifact,
} from "./worklog.ts";

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
      slackChannel: null,
      slackThreadTs: null,
      error: null,
    };
    await this.store.createRun(run);

    let summary = "";
    let body = "";
    try {
      const direct = await this.runDirectStep(request.definition);
      body = direct.artifactBody;
      summary = direct.summary;

      if (request.definition.runner) {
        const runnerSummary = await this.summarizeWithRunner(
          request.definition,
          direct.runnerInput,
        );
        if (runnerSummary) summary = runnerSummary;
      }

      body = renderArtifact({
        definition: request.definition,
        run,
        summary,
        body,
      });
      await writeArtifact(artifactPath, body);
      const slackMeta = await this.emitOutputs(request.definition, summary);
      run.slackChannel = slackMeta.channel;
      run.slackThreadTs = slackMeta.threadTs;
      run.status = "success";
      run.finishedAt = this.now().getTime();
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
        body: body || "",
      });
      await writeArtifact(artifactPath, failureBody).catch(() => undefined);
      await this.store.updateRun(run);
      await this.updateStateAfterRun(request.definition, run);
      throw err;
    }
  }

  private async runDirectStep(definition: WorkflowDefinition): Promise<{
    summary: string;
    artifactBody: string;
    runnerInput: string;
  }> {
    if (definition.name === "worklog") {
      const repos = this.reposFor(definition);
      const until = this.now();
      const since = new Date(until.getTime() - 24 * 60 * 60 * 1000);
      const activity = await collectWorklogActivity({ repos, since, until });
      const summary = formatWorklogSlackSummary(activity);
      return {
        summary,
        artifactBody: renderWorklogArtifact(activity, summary),
        runnerInput: JSON.stringify(activity, null, 2),
      };
    }

    const summary = definition.prompt.trim() || `Workflow ${definition.name} ran.`;
    return {
      summary,
      artifactBody: "No direct workflow adapter is configured for this workflow.",
      runnerInput: summary,
    };
  }

  private async summarizeWithRunner(
    definition: WorkflowDefinition,
    input: string,
  ): Promise<string | null> {
    const runner = definition.runner;
    if (!runner) return null;
    const provider: ImplementedRunnerProvider =
      runner.provider === "default" ? this.config.runner.provider : runner.provider;
    const session = createSession(
      `workflow-${definition.name}`,
      "workflow",
      "quiet",
      provider,
      this.config.claude.defaultDriver,
    );
    session.cwd = "/tmp/junior-utility";
    session.agentType = runner.agentName;
    session.activeAgentName = runner.agentName;
    session.model = runner.model ?? null;
    session.systemPrompt = [
      "You are compressing a Junior workflow run into a concise operational summary.",
      "Use Slack mrkdwn only. Do not invent facts.",
      definition.prompt,
    ].join("\n\n");

    const handle = this.spawn(
      session,
      [
        "Summarize this workflow input.",
        "Keep it grouped and compact.",
        "",
        input,
      ].join("\n"),
      this.config,
    );
    const bounded = withTimeout(
      handle,
      runner.timeoutMs ?? this.timeoutFor(provider),
      () => handle.kill(),
    );
    const result = await bounded.result;
    if (result.exitCode !== 0 || result.error) {
      log.warn("workflow", `runner summary failed workflow=${definition.name}: ${result.error ?? result.exitCode}`);
      return null;
    }
    const response = result.response.trim();
    return response || null;
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
  body: string;
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
    options.run.error ? `Error: ${options.run.error}` : null,
    "",
    "## Final Summary",
    "",
    options.summary,
    "",
    options.body,
    "",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}
