import type { RunnerEvent, RunnerEventTool, SpawnResult } from "../runners/types.ts";
import type { SlackMessageEvent } from "../slack/events.ts";
import type { MemoryStore } from "./store.ts";

export interface CaptureSlackMessageOptions {
  agentName: string;
  route?: string;
}

export class MemoryIngestor {
  constructor(private store: MemoryStore) {}

  async captureSlackMessage(
    event: SlackMessageEvent,
    options: CaptureSlackMessageOptions,
  ): Promise<void> {
    const now = Date.now();
    const sourceId = sourceIdFor("slack", event.threadId, event.ts, options.agentName);
    await this.store.appendSourceRecord({
      id: sourceId,
      kind: event.command ? "routing_decision" : "slack_message",
      channelId: event.channel,
      threadId: event.threadId,
      slackTs: event.ts,
      actorId: event.user,
      actorKind: event.botId ? "bot" : "human",
      body: event.text,
      metadata: {
        command: event.command,
        route: options.route ?? options.agentName,
        files: event.files?.map((file) => ({ name: file.name, mimetype: file.mimetype })),
        isSelfBot: event.isSelfBot ?? false,
        botId: event.botId ?? null,
      },
      createdAt: now,
    });
  }

  async captureRunnerResult(
    threadId: string,
    agentName: string,
    result: SpawnResult,
  ): Promise<void> {
    const now = Date.now();
    const body = result.error
      ? `Runner ${agentName} failed: ${result.error}`
      : (result.response.trim() || `Runner ${agentName} completed with no text response.`);
    const sourceId = sourceIdFor("runner", threadId, `${now}_${result.sessionId ?? "nosession"}`, agentName);
    await this.store.appendSourceRecord({
      id: sourceId,
      kind: "runner_output",
      threadId,
      actorKind: "agent",
      agentName,
      body,
      metadata: {
        provider: result.provider,
        sessionId: result.sessionId,
        exitCode: result.exitCode,
        error: result.error,
        eventTypes: result.events.map((event) => event.type),
      },
      createdAt: now,
    });
  }

  async captureRoutingDecision(input: {
    threadId: string;
    channelId: string;
    slackTs: string;
    user: string;
    selectedAgent: string;
    reason: string;
    text: string;
  }): Promise<void> {
    const now = Date.now();
    const sourceId = sourceIdFor("route", input.threadId, input.slackTs, input.selectedAgent);
    await this.store.appendSourceRecord({
      id: sourceId,
      kind: "routing_decision",
      channelId: input.channelId,
      threadId: input.threadId,
      slackTs: input.slackTs,
      actorId: input.user,
      actorKind: "system",
      agentName: input.selectedAgent,
      body: input.reason,
      metadata: { text: input.text },
      createdAt: now,
    });
  }

  async captureRunnerEvents(
    threadId: string,
    agentName: string,
    events: RunnerEvent[],
  ): Promise<void> {
    const notable = events.filter(
      (event): event is RunnerEventTool => event.type === "tool" && event.status !== "completed",
    );
    for (const [index, event] of notable.entries()) {
      const now = Date.now();
      const sourceId = sourceIdFor("runner_event", threadId, `${now}_${index}`, agentName);
      await this.store.appendSourceRecord({
        id: sourceId,
        kind: "runner_output",
        threadId,
        actorKind: "agent",
        agentName,
        body: JSON.stringify(event),
        metadata: { ...event },
        createdAt: now,
      });
    }
  }
}

export function sourceIdFor(prefix: string, threadId: string, ts: string, suffix: string): string {
  return `${prefix}_${slug(threadId)}_${slug(ts)}_${slug(suffix)}`;
}

export function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
}

export function importanceForText(text: string, command: string | null): number {
  if (command) return 0.7;
  if (/\b(blocked|failed|error|wrong|correct|decision|remember|prefer)\b/i.test(text)) return 0.8;
  if (text.length < 20) return 0.2;
  return 0.5;
}

export function tagsForMessage(text: string, command: string | null, agentName: string): string[] {
  const tags = ["slack_message", `agent:${agentName}`];
  if (command) tags.push(`command:${command}`);
  if (/\bPR\s*#?\d+|github\.com\/.*\/pull\/\d+/i.test(text)) tags.push("pr_review");
  if (/\b(css|style|ui|frontend|tsx|react)\b/i.test(text)) tags.push("frontend");
  if (/\b(api|backend|server|endpoint|500)\b/i.test(text)) tags.push("backend");
  if (/\bwrong|correct|instead|should use\b/i.test(text)) tags.push("correction");
  return tags;
}

export function entitiesForMessage(text: string): Array<{ kind: string; name: string }> {
  const entities: Array<{ kind: string; name: string }> = [];
  for (const match of text.matchAll(/\b[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|md|json)\b/g)) {
    entities.push({ kind: "file", name: match[0] });
  }
  for (const match of text.matchAll(/\b[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\b/g)) {
    entities.push({ kind: "path", name: match[0] });
  }
  return entities;
}
