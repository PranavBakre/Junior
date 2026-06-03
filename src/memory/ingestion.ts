import type { RunnerEvent, RunnerEventTool, SpawnResult } from "../runners/types.ts";
import type { SlackMessageEvent } from "../slack/events.ts";
import type { MemoryStore } from "./store.ts";

export interface CaptureSlackMessageOptions {
  agentName: string;
  route?: string;
}

export class MemoryIngestor {
  private acceptedRulesCache: Awaited<ReturnType<MemoryStore["getAcceptedRules"]>> | null = null;
  private acceptedRulesCacheTime = 0;

  constructor(private store: MemoryStore) {}

  private async getAcceptedRules(): Promise<Awaited<ReturnType<MemoryStore["getAcceptedRules"]>>> {
    // Cache for 60 seconds to avoid hitting the DB on every Slack message.
    if (this.acceptedRulesCache && Date.now() - this.acceptedRulesCacheTime < 60_000) {
      return this.acceptedRulesCache;
    }
    this.acceptedRulesCache = await this.store.getAcceptedRules();
    this.acceptedRulesCacheTime = Date.now();
    return this.acceptedRulesCache;
  }

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
    const baseTags = tagsForMessage(event.text, event.command, options.agentName);
    const ruleTags = await this.tagsFromAcceptedRules(event.text);
    const allTags = [...baseTags, ...ruleTags.filter((tag) => !baseTags.includes(tag))];
    await this.store.upsertEvent({
      id: `event_${sourceId}`,
      sourceRecordId: sourceId,
      threadId: event.threadId,
      body: event.text,
      outcome: event.command ? `command:${event.command}` : null,
      importance: importanceForText(event.text, event.command),
      createdAt: now,
      sourceTs: event.ts,
      tags: allTags,
      entities: entitiesForMessage(event.text),
    });
  }

  /**
   * Apply accepted tag rules from the consolidation engine.
   * Each accepted rule with domain "tag" is checked against the message text.
   * The tag name is extracted from the rule ID suffix (e.g., rule_tag_frontend → frontend).
   */
  private async tagsFromAcceptedRules(text: string): Promise<string[]> {
    const rules = await this.getAcceptedRules();
    const tags: string[] = [];
    for (const rule of rules) {
      if (rule.domain !== "tag") continue;
      const tagName = ruleTagName(rule.id);
      if (!tagName) continue;
      if (tagMatchesText(tagName, text)) {
        tags.push(tagName);
      }
    }
    return tags;
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
    await this.store.upsertEvent({
      id: `event_${sourceId}`,
      sourceRecordId: sourceId,
      threadId,
      body,
      outcome: result.error ? "runner_error" : "runner_completed",
      importance: result.error ? 0.8 : 0.4,
      createdAt: now,
      tags: ["runner_output", result.error ? "error" : "completed", `agent:${agentName}`],
      entities: [{ kind: "agent", name: agentName }],
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
    await this.store.upsertFact({
      id: `routing_memory_decision_${sourceId}`,
      kind: "routing_memory",
      title: `Routing decision: ${input.selectedAgent}`,
      body: input.reason,
      confidence: 0.7,
      importance: 0.4,
      createdAt: now,
      sourceIds: [sourceId],
      tags: ["routing_decision", `agent:${input.selectedAgent}`],
      entities: [{ kind: "agent", name: input.selectedAgent }],
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
      await this.store.upsertEvent({
        id: `event_${sourceId}`,
        sourceRecordId: sourceId,
        threadId,
        body: `Runner tool error for ${agentName}: ${event.name}`,
        outcome: "tool_error",
        importance: 0.7,
        createdAt: now,
        tags: ["runner_tool_error", `agent:${agentName}`],
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

/**
 * Extract a tag name from a rule ID like "rule_tag_frontend" → "frontend".
 */
function ruleTagName(ruleId: string): string | null {
  const match = ruleId.match(/^rule_tag_(.+)$/);
  return match ? match[1] : null;
}

/**
 * Check if an accepted tag rule's tag name matches the message text.
 * Uses the same heuristics as tagsForMessage plus rule-specific matching.
 */
function tagMatchesText(tagName: string, text: string): boolean {
  const patterns: Record<string, RegExp> = {
    frontend: /\b(css|style|ui|frontend|tsx|react|component|jsx)\b/i,
    backend: /\b(api|backend|server|endpoint|500|route|controller)\b/i,
    pr_review: /\bPR\s*#?\d+|github\.com\/.*\/pull\/\d+/i,
    correction: /\bwrong|correct|instead|should use|prefer\b/i,
    error: /\b(error|failed|crash|timeout|500|503)\b/i,
    bug: /\b(bug|broken|regression|not working)\b/i,
  };
  const pattern = patterns[tagName];
  if (pattern) return pattern.test(text);
  // For unknown tag names, check if the tag name itself appears in the text.
  return new RegExp(`\\b${tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text);
}
