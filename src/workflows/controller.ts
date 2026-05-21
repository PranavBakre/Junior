import type { WebClient } from "@slack/web-api";
import type { SlackMessageEvent } from "../slack/events.ts";
import type { WorkflowRegistry } from "./registry.ts";
import type { WorkflowScheduler } from "./scheduler.ts";
import type { WorkflowStore } from "./store.ts";
import type {
  WorkflowDefinition,
  WorkflowRunReason,
  WorkflowSlackEventTrigger,
} from "./types.ts";

export interface WorkflowControllerOptions {
  registry: WorkflowRegistry;
  store: WorkflowStore;
  scheduler: WorkflowScheduler;
  slackClient: WebClient;
  isAdmin: (userId: string) => Promise<boolean>;
}

export class WorkflowController {
  private registry: WorkflowRegistry;
  private store: WorkflowStore;
  private scheduler: WorkflowScheduler;
  private slackClient: WebClient;
  private isAdmin: (userId: string) => Promise<boolean>;

  constructor(options: WorkflowControllerOptions) {
    this.registry = options.registry;
    this.store = options.store;
    this.scheduler = options.scheduler;
    this.slackClient = options.slackClient;
    this.isAdmin = options.isAdmin;
  }

  async handleMessage(event: SlackMessageEvent): Promise<boolean> {
    if (event.command === "workflows") {
      await this.listWorkflows(event);
      return true;
    }
    if (event.command === "workflow") {
      await this.handleWorkflowCommand(event);
      return true;
    }

    const commandName = customCommandName(event);
    if (commandName) {
      const definition = this.findByCommand(commandName);
      if (!definition) return false;
      await this.runFromHumanTrigger(event, definition, "command");
      return true;
    }

    const eventMatches = this.findBySlackEvent(event);
    if (eventMatches.length === 0) return false;
    for (const definition of eventMatches) {
      await this.runFromHumanTrigger(event, definition, "event");
    }
    return true;
  }

  private async handleWorkflowCommand(event: SlackMessageEvent): Promise<void> {
    const [action = "", name = ""] = event.text.trim().split(/\s+/, 2);
    if (!action || action === "help") {
      await this.reply(event, [
        "*Workflow commands:*",
        "`!workflows` — list workflows",
        "`!workflow show <name>` — show workflow status",
        "`!workflow run <name>` — run once",
        "`!workflow stop <name>` — stop scheduled and event runs",
        "`!workflow start <name>` — resume a stopped workflow",
        "`!workflow logs <name>` — show recent runs",
        "`!workflow reload` — force a workflow file rescan",
      ].join("\n"));
      return;
    }

    if (action === "reload") {
      if (!(await this.isAdmin(event.user))) {
        await this.react(event, "x");
        return;
      }
      const snapshot = await this.registry.reload();
      await this.scheduler.reconcile(snapshot);
      await this.reply(event, `Reloaded ${snapshot.definitions.size} workflow${snapshot.definitions.size === 1 ? "" : "s"} with ${snapshot.errors.length} validation error${snapshot.errors.length === 1 ? "" : "s"}.`);
      return;
    }

    if (!name) {
      await this.reply(event, `Usage: \`!workflow ${action} <name>\``);
      return;
    }

    const definition = this.registry.get(name);
    if (!definition && action !== "logs") {
      await this.reply(event, `Unknown workflow: *${name}*.`);
      return;
    }

    switch (action) {
      case "show":
        await this.showWorkflow(event, name);
        return;
      case "logs":
        await this.showLogs(event, name);
        return;
      case "run":
        if (!definition) return;
        await this.runFromHumanTrigger(event, definition, "manual");
        return;
      case "stop":
        if (!definition || !(await this.canManage(event.user, definition))) {
          await this.react(event, "x");
          return;
        }
        await this.scheduler.stopWorkflow(name);
        await this.reply(event, `Stopped *${name}*.`);
        return;
      case "start":
        if (!definition || !(await this.canManage(event.user, definition))) {
          await this.react(event, "x");
          return;
        }
        try {
          await this.scheduler.startWorkflow(name);
          await this.reply(event, `Started *${name}*.`);
        } catch (err) {
          await this.reply(event, formatError(err));
        }
        return;
      default:
        await this.reply(event, `Unknown workflow action: *${action}*.`);
    }
  }

  private async runFromHumanTrigger(
    event: SlackMessageEvent,
    definition: WorkflowDefinition,
    reason: WorkflowRunReason,
  ): Promise<void> {
    if (!(await this.canManage(event.user, definition))) {
      await this.react(event, "x");
      return;
    }
    try {
      const result = await this.scheduler.runNow({
        name: definition.name,
        reason,
        actorSlackUserId: event.user,
      });
      await this.reply(
        event,
        result.runId
          ? `Ran *${definition.name}*: ${result.summary}`
          : result.summary,
      );
    } catch (err) {
      await this.reply(event, formatError(err));
    }
  }

  private async listWorkflows(event: SlackMessageEvent): Promise<void> {
    const definitions = this.registry.all();
    if (definitions.length === 0) {
      await this.reply(event, "No workflows loaded.");
      return;
    }
    const lines = ["*Workflows:*"];
    for (const definition of definitions) {
      const state = await this.store.getState(definition.name);
      const fileStatus = definition.enabled ? "enabled" : "disabled";
      const runtimeStatus = state?.status ?? (definition.enabled ? "active" : "stopped");
      const nextRun = state?.nextRunAt ? new Date(state.nextRunAt).toISOString() : "none";
      lines.push(`- *${definition.name}* — ${fileStatus}, ${runtimeStatus}, next: ${nextRun}`);
    }
    const errors = this.registry.getErrors();
    if (errors.length > 0) {
      lines.push("", "*Validation errors:*");
      for (const error of errors.slice(0, 5)) {
        lines.push(`- ${error.path}: ${error.message}`);
      }
    }
    await this.reply(event, lines.join("\n"));
  }

  private async showWorkflow(event: SlackMessageEvent, name: string): Promise<void> {
    const definition = this.registry.get(name);
    if (!definition) {
      await this.reply(event, `Unknown workflow: *${name}*.`);
      return;
    }
    const state = await this.store.getState(name);
    await this.reply(event, [
      `*${definition.name}*`,
      `Description: ${definition.description ?? "none"}`,
      `File: ${definition.sourcePath}`,
      `File enabled: ${definition.enabled ? "yes" : "no"}`,
      `Runtime status: ${state?.status ?? "unknown"}`,
      `Version: ${definition.versionHash}`,
      `Next run: ${state?.nextRunAt ? new Date(state.nextRunAt).toISOString() : "none"}`,
      `Last run: ${state?.lastRunAt ? new Date(state.lastRunAt).toISOString() : "never"}`,
      `Last status: ${state?.lastRunStatus ?? "none"}`,
      state?.lastError ? `Last error: ${state.lastError}` : null,
    ].filter((line): line is string => line !== null).join("\n"));
  }

  private async showLogs(event: SlackMessageEvent, name: string): Promise<void> {
    const runs = await this.store.listRuns(name, 5);
    if (runs.length === 0) {
      await this.reply(event, `No runs for *${name}*.`);
      return;
    }
    await this.reply(event, [
      `*Recent runs for ${name}:*`,
      ...runs.map((run) =>
        `- ${run.status} ${new Date(run.startedAt).toISOString()} ${run.artifactPath}${run.error ? ` (${run.error})` : ""}`,
      ),
    ].join("\n"));
  }

  private findByCommand(command: string): WorkflowDefinition | undefined {
    return this.registry.all().find((definition) =>
      definition.triggers.some(
        (trigger) => trigger.type === "command" && trigger.command === command,
      ),
    );
  }

  private findBySlackEvent(event: SlackMessageEvent): WorkflowDefinition[] {
    return this.registry.all().filter((definition) =>
      definition.triggers.some((trigger) =>
        trigger.type === "slack-event" && slackEventMatches(trigger, event),
      ),
    );
  }

  private async canManage(userId: string, definition: WorkflowDefinition): Promise<boolean> {
    return definition.ownerSlackUserIds.includes(userId) || await this.isAdmin(userId);
  }

  private async reply(event: SlackMessageEvent, text: string): Promise<void> {
    await this.slackClient.chat.postMessage({
      channel: event.channel,
      thread_ts: event.threadId,
      text,
    });
  }

  private async react(event: SlackMessageEvent, name: string): Promise<void> {
    await this.slackClient.reactions.add({
      channel: event.channel,
      timestamp: event.ts,
      name,
    }).catch(() => undefined);
  }
}

function customCommandName(event: SlackMessageEvent): string | null {
  if (event.command) return null;
  const match = event.text.match(/^!([a-z0-9][a-z0-9-]*)(?:\s|$)/);
  return match?.[1] ?? null;
}

function slackEventMatches(
  trigger: WorkflowSlackEventTrigger,
  event: SlackMessageEvent,
): boolean {
  if (trigger.channel !== event.channel) return false;
  if (!trigger.pattern) return true;
  return new RegExp(trigger.pattern).test(event.text);
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
