import type { WebClient } from "@slack/web-api";
import type { SlackMessageEvent } from "../slack/events.ts";
import type { SessionManager } from "../session/manager.ts";
import type { SessionStore } from "../session/store/interface.ts";
import type { DevServerQueue } from "../lifecycle/dev-server-queue.ts";
import type { RepoConfig } from "../config.ts";
import { agentForUsername, isPersistentAgent } from "./agents.ts";
import { log } from "../logger.ts";

export interface AgentDirective {
  agentName: string;
  prompt: string;
  line: string;
}

// ---------------------------------------------------------------------------
// Devserver directive types
// ---------------------------------------------------------------------------

export type DevserverDirective =
  | { kind: "acquire"; branch: string; repos: string[] }
  | { kind: "status" }
  | { kind: "kill"; repo: string }
  | { kind: "malformed"; reason: string };

/**
 * Parse a `!devserver` directive from a single text line.
 * Recognized forms:
 *   !devserver <branch>               — acquire for all repos in session
 *   !devserver <branch> <repo>        — acquire for a specific repo
 *   !devserver status                 — show queue depth for all repos
 *   !devserver kill <repo>            — kill dev server for a repo
 *
 * Returns null for malformed or non-matching input.
 */
export function parseDevserverDirective(line: string): DevserverDirective | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("!devserver")) return null;

  const rest = trimmed.slice("!devserver".length).trim();

  // !devserver status
  if (rest === "status") {
    return { kind: "status" };
  }

  // !devserver kill <repo>
  const killMatch = rest.match(/^kill\s+(\S+)$/);
  if (killMatch) {
    return { kind: "kill", repo: killMatch[1] };
  }
  // Bare `kill` with no repo — explicit malformed so the handler can post a
  // usage hint. Without this guard, the token-split below would parse it as
  // an acquire for branch "kill", which silently spawns a dev server on a
  // branch named after a reserved sub-command.
  if (rest === "kill" || /^kill(\s|$)/.test(rest)) {
    return { kind: "malformed", reason: "Usage: !devserver kill <repo>" };
  }

  // !devserver <branch> [repo]
  // Branch names can contain slashes and hyphens. If there are two tokens
  // separated by whitespace, the last one is the (optional) repo name.
  // We use a simple split: if exactly one token — it's the branch; if two —
  // first is branch, second is repo.
  // Edge: "status" and "kill" are reserved first tokens handled above.
  if (!rest) return null;

  const tokens = rest.split(/\s+/);
  if (tokens.length === 1) {
    return { kind: "acquire", branch: tokens[0], repos: [] };
  }
  if (tokens.length === 2) {
    return { kind: "acquire", branch: tokens[0], repos: [tokens[1]] };
  }
  // More than 2 tokens — not recognized.
  return null;
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
 * - If the message contains `!devserver` directives, handle them inline
 *   (no agent spawned — junior manages the dev server directly).
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
  private devServerQueue: DevServerQueue | null;
  private sessionStore: SessionStore | null;
  private slackClient: WebClient | null;
  private repos: RepoConfig[];

  constructor(
    manager: SessionManager,
    supportChannels: Set<string>,
    opts: {
      devServerQueue?: DevServerQueue;
      sessionStore?: SessionStore;
      slackClient?: WebClient;
      repos?: RepoConfig[];
    } = {},
  ) {
    this.manager = manager;
    this.supportChannels = supportChannels;
    this.devServerQueue = opts.devServerQueue ?? null;
    this.sessionStore = opts.sessionStore ?? null;
    this.slackClient = opts.slackClient ?? null;
    this.repos = opts.repos ?? [];
  }

  isSupportChannel(channel: string): boolean {
    return this.supportChannels.has(channel);
  }

  async handleMessage(event: SlackMessageEvent): Promise<void> {
    const isSupport = this.supportChannels.has(event.channel);

    // Check for !devserver directives first. These are handled inline by
    // junior — they don't spawn a Claude agent.
    const devserverDirective = findDevserverDirective(event.text);
    if (devserverDirective) {
      await this.handleDevserverDirective(event, devserverDirective);
      return;
    }

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
        await this.manager.handleLeadMessage({
          ...event,
          dedupeKey: event.dedupeKey ?? `${event.ts}:lead`,
        });
        return;
      }
      // Human (or non-self-bot) with no directives.
      if (isSupport) {
        await this.manager.handleLeadMessage({
          ...event,
          dedupeKey: event.dedupeKey ?? `${event.ts}:lead`,
        });
      } else {
        // Non-support channel: generic single-session Claude (no lead identity,
        // no persistent-agent state block, no orchestrator system prompt).
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
        await this.manager.handleLeadMessage({
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

  // ---------------------------------------------------------------------------
  // !devserver inline handler
  // ---------------------------------------------------------------------------

  private async handleDevserverDirective(
    event: SlackMessageEvent,
    directive: DevserverDirective,
  ): Promise<void> {
    if (!this.slackClient) {
      log.warn("devserver", "!devserver directive received but no slackClient configured; dropping");
      return;
    }

    if (directive.kind === "malformed") {
      await this.postSlack(event, directive.reason);
      return;
    }

    if (directive.kind === "status") {
      await this.handleDevserverStatus(event);
      return;
    }

    if (directive.kind === "kill") {
      await this.handleDevserverKill(event, directive.repo);
      return;
    }

    // directive.kind === "acquire"
    await this.handleDevserverAcquire(event, directive);
  }

  private async handleDevserverAcquire(
    event: SlackMessageEvent,
    directive: Extract<DevserverDirective, { kind: "acquire" }>,
  ): Promise<void> {
    if (!this.devServerQueue || !this.slackClient) {
      await this.postSlack(event, "dev-server queue not configured; cannot process `!devserver`.");
      return;
    }

    // Determine target repos: explicit arg, or all repos in session.worktreePaths.
    let targetRepoNames: string[];
    if (directive.repos.length > 0) {
      targetRepoNames = directive.repos;
    } else {
      // Fall back to all repos with devCommand (from config).
      const session = this.sessionStore ? await this.sessionStore.get(event.threadId) : null;
      const sessionRepos = session ? Object.keys(session.worktreePaths) : [];
      // Filter to only repos that have devCommand configured.
      const devRepos = this.repos.filter((r) => r.devCommand).map((r) => r.name);
      targetRepoNames = sessionRepos.length > 0
        ? sessionRepos.filter((r) => devRepos.includes(r))
        : devRepos;
    }

    if (targetRepoNames.length === 0) {
      await this.postSlack(event, "No repos with dev servers found for this thread.");
      return;
    }

    const { branch } = directive;

    // Acquire repos in alphabetical order to prevent deadlocks when multiple
    // threads acquire overlapping repo sets (e.g. full-stack bugs).
    const sortedRepos = [...targetRepoNames].sort();

    // Post "queued" immediately so the thread sees it was picked up.
    const queuedParts: string[] = [];
    for (const repoName of sortedRepos) {
      try {
        const depth = await this.devServerQueue.readQueueDepth(repoName);
        const waitersAhead = depth.holder ? depth.waiters.length : 0;
        if (waitersAhead > 0) {
          queuedParts.push(`\`${repoName}\`: queued behind ${waitersAhead} other${waitersAhead === 1 ? "" : "s"}`);
        }
      } catch {
        // ignore — not fatal for the status message
      }
    }
    if (queuedParts.length > 0) {
      await this.postSlack(event, `dev-server: acquiring slots... ${queuedParts.join(", ")}`);
    }

    const slotTimeoutMs = 10 * 60 * 1_000;
    const releaseHandles: Array<() => Promise<void>> = [];

    try {
      // Acquire all repos sequentially (alphabetical order to prevent deadlock).
      for (const repoName of sortedRepos) {
        const repo = this.repos.find((r) => r.name === repoName);
        if (!repo?.devCommand) {
          await this.postSlack(event, `\`${repoName}\`: no dev server configured — skipping.`);
          continue;
        }

        try {
          const { release, info } = await this.devServerQueue.acquire(
            repoName,
            branch,
            event.threadId,
            slotTimeoutMs,
          );
          releaseHandles.push(release);

          const port = info.port > 0 ? info.port : repo.devPort ?? "?";
          await this.postSlack(
            event,
            `dev-server \`${repoName}\` on \`${branch}\`: ready @ localhost:${port}`,
          );
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          await this.postSlack(event, `dev-server \`${repoName}\`: failed — ${reason}`);
        }
      }

      // Hold the slot for slotTimeoutMs, then auto-release.
      await sleep(slotTimeoutMs);
    } finally {
      // Auto-release all acquired locks.
      for (const release of releaseHandles) {
        try {
          await release();
        } catch {
          // non-fatal
        }
      }
      if (releaseHandles.length > 0) {
        // postSlack must not throw out of `finally`. handleMessage is fired
        // and forgotten from index.ts, so any unhandled rejection past the
        // 10-min sleep would surface as an `unhandledRejection` event with no
        // catch site. Wrap defensively.
        try {
          await this.postSlack(
            event,
            `dev-server: slot timeout — released (${sortedRepos.join(", ")}).`,
          );
        } catch (err) {
          log.warn(
            "devserver",
            `failed to post slot-timeout notification: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  private async handleDevserverStatus(event: SlackMessageEvent): Promise<void> {
    if (!this.devServerQueue) {
      await this.postSlack(event, "dev-server queue not configured.");
      return;
    }

    const devRepos = this.repos.filter((r) => r.devCommand);
    if (devRepos.length === 0) {
      await this.postSlack(event, "No repos with dev servers configured.");
      return;
    }

    const lines: string[] = ["*dev-server status*"];
    for (const repo of devRepos) {
      const depth = await this.devServerQueue.readQueueDepth(repo.name);
      const holderStr = depth.holder
        ? `held by thread \`${depth.holder.holderThreadId}\` on branch \`${depth.holder.branch}\` (since ${new Date(depth.holder.acquiredAt).toISOString()})`
        : "idle";
      const waiterCount = depth.waiters.length;
      // ETA heuristic: each waiter holds the slot for ~30s on average.
      // This is a rough estimate documented here — real hold time varies widely.
      const etaStr = waiterCount > 0 ? ` — ${waiterCount} waiter${waiterCount === 1 ? "" : "s"}, ~${waiterCount * 30}s ETA` : "";
      lines.push(`• \`${repo.name}\` (port ${repo.devPort ?? "?"}): ${holderStr}${etaStr}`);
    }

    await this.postSlack(event, lines.join("\n"));
  }

  private async handleDevserverKill(event: SlackMessageEvent, repoName: string): Promise<void> {
    if (!this.devServerQueue) {
      await this.postSlack(event, "dev-server queue not configured.");
      return;
    }

    const repo = this.repos.find((r) => r.name === repoName);
    if (!repo) {
      await this.postSlack(event, `Unknown repo \`${repoName}\`. Valid repos: ${this.repos.map((r) => r.name).join(", ")}.`);
      return;
    }

    try {
      await this.devServerQueue.kill(repoName);
      await this.postSlack(event, `dev-server \`${repoName}\`: killed.`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await this.postSlack(event, `dev-server \`${repoName}\`: kill failed — ${reason}`);
    }
  }

  private async postSlack(event: SlackMessageEvent, text: string): Promise<void> {
    if (!this.slackClient) return;
    try {
      await this.slackClient.chat.postMessage({
        channel: event.channel,
        thread_ts: event.threadId,
        text,
        username: "Junior",
        icon_emoji: ":face_with_cowboy_hat:",
      });
    } catch (err) {
      log.error("devserver", `postSlack failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/**
 * Scan all lines in `text` for a `!devserver` directive and return the first
 * one found, or null if none.
 */
function findDevserverDirective(text: string): DevserverDirective | null {
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseDevserverDirective(line);
    if (parsed) return parsed;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Re-export for callers that import these from here.
export { readWaiters, readHolderMeta } from "../lifecycle/dev-server-queue.ts";
