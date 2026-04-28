import type { SlackMessageEvent } from "../slack/events.ts";
import type { SessionManager } from "../session/manager.ts";
import { agentForUsername, isPersistentAgent } from "./agents.ts";

export interface AgentDirective {
  agentName: string;
  prompt: string;
  line: string;
}

export function parseAgentDirectives(text: string): AgentDirective[] {
  const directives: AgentDirective[] = [];
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const match = line.match(/^!(\S+)(?:\s+(.*))?$/);
    if (!match) continue;

    const agentName = match[1];
    if (!isPersistentAgent(agentName)) continue;

    directives.push({
      agentName,
      prompt: (match[2] ?? "").trim(),
      line,
    });
  }

  return directives;
}

export class SupportRouter {
  private manager: SessionManager;
  private supportChannels: Set<string>;

  constructor(manager: SessionManager, supportChannels: Set<string>) {
    this.manager = manager;
    this.supportChannels = supportChannels;
  }

  shouldRoute(event: SlackMessageEvent): boolean {
    return this.supportChannels.has(event.channel);
  }

  async handleMessage(event: SlackMessageEvent): Promise<void> {
    const directives = parseAgentDirectives(event.text);
    const sourceAgent = event.isSelfBot
      ? agentForUsername(event.botUsername)
      : null;

    if (directives.length === 0) {
      // Lead reading its own commentary would trigger an infinite wake-loop.
      // Drop self-bot+no-directives where source is lead or unknown.
      if (event.isSelfBot && sourceAgent !== null && sourceAgent !== "lead") {
        // Worker response — forward to lead so it can decide next step.
        await this.manager.handleMessage({
          ...event,
          dedupeKey: event.dedupeKey ?? `${event.ts}:lead`,
        });
        return;
      }
      if (event.isSelfBot) {
        // Lead's own message or unknown self-bot — drop.
        return;
      }
      await this.manager.handleMessage({
        ...event,
        dedupeKey: event.dedupeKey ?? `${event.ts}:lead`,
      });
      return;
    }

    if (event.isSelfBot && sourceAgent !== "lead") {
      // Only lead can emit !<agent> directives. Worker or unknown — drop the
      // directives, route the message text to lead so it sees what was said.
      await this.manager.handleMessage({
        ...event,
        dedupeKey: event.dedupeKey ?? `${event.ts}:lead`,
      });
      return;
    }

    const byAgent = new Map<string, Array<{ directive: AgentDirective; index: number }>>();
    directives.forEach((directive, index) => {
      const entries = byAgent.get(directive.agentName) ?? [];
      entries.push({ directive, index });
      byAgent.set(directive.agentName, entries);
    });

    await Promise.all(
      [...byAgent].map(async ([agentName, entries]) => {
        for (const { directive, index } of entries) {
          await this.manager.handleAgentMessage(
            {
              ...event,
              text: directive.prompt,
              command: null,
              dedupeKey: `${event.ts}:${agentName}:${index}`,
            },
            agentName,
          );
        }
      }),
    );
  }
}
