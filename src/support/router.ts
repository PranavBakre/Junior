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

/**
 * Universal entry point for Slack messages, used in any channel:
 *
 * - If the message contains `!<persistent-agent>` directives (or parseCommand
 *   already consumed one into event.command), dispatch to those persistent
 *   agents. Works in any channel — `!review` in #junior creates a review
 *   persistent-agent session in that thread, same as in #bugs-backlog.
 * - If no directives, fall through to the existing single-session manager.
 *   In support channels (channelDefaults.agentType === "lead"), lead is the
 *   default recipient; non-support channels keep their existing behavior.
 *
 * The lead-only-dispatch invariant + self-loop break + worker-can't-dispatch
 * guards apply only when the channel is a support channel (where lead exists).
 */
export class AgentDispatcher {
  private manager: SessionManager;
  private supportChannels: Set<string>;

  constructor(manager: SessionManager, supportChannels: Set<string>) {
    this.manager = manager;
    this.supportChannels = supportChannels;
  }

  isSupportChannel(channel: string): boolean {
    return this.supportChannels.has(channel);
  }

  async handleMessage(event: SlackMessageEvent): Promise<void> {
    const isSupport = this.supportChannels.has(event.channel);

    // parseCommand (commands.ts) may have stripped a leading !<token> if <token>
    // is in KNOWN_COMMANDS. Reconstruct the directive when the command is also
    // a persistent-agent name (e.g., `review` was in both sets).
    const directives = parseAgentDirectives(event.text);
    if (event.command && isPersistentAgent(event.command)) {
      directives.unshift({
        agentName: event.command,
        prompt: event.text.trim(),
        line: `!${event.command} ${event.text}`,
      });
    }

    const sourceAgent = event.isSelfBot
      ? agentForUsername(event.botUsername)
      : null;

    if (directives.length === 0) {
      // Drop self-bot loops in support channels (lead reading its own posts).
      // In non-support channels, drop self-bot too — bots shouldn't trigger
      // new turns on their own posts regardless of channel.
      if (event.isSelfBot && (sourceAgent === "lead" || sourceAgent === null)) {
        return;
      }
      // Worker self-bot (non-lead) without directives: forward to lead in
      // support channels so it can decide next step. In non-support channels
      // there's no lead — fall through to the regular session manager.
      if (event.isSelfBot && isSupport) {
        await this.manager.handleMessage({
          ...event,
          dedupeKey: event.dedupeKey ?? `${event.ts}:lead`,
        });
        return;
      }
      // Human (or non-self-bot) with no directives.
      if (isSupport) {
        await this.manager.handleMessage({
          ...event,
          dedupeKey: event.dedupeKey ?? `${event.ts}:lead`,
        });
      } else {
        await this.manager.handleMessage(event);
      }
      return;
    }

    // Has directives.
    // In support channels, only lead may emit them; workers/unknown self-bots
    // get the directives stripped (re-routed to lead as plain text).
    // In non-support channels there's no lead-only invariant — humans drive.
    // Self-bot directives in non-support channels are weird (single-session
    // bots don't typically dispatch); drop them too rather than risk loops.
    if (event.isSelfBot && sourceAgent !== "lead") {
      if (isSupport) {
        await this.manager.handleMessage({
          ...event,
          dedupeKey: event.dedupeKey ?? `${event.ts}:lead`,
        });
      }
      return;
    }

    // Dispatch each directive (works in any channel).
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

// Back-compat export name for callers that haven't been updated yet.
export const SupportRouter = AgentDispatcher;
