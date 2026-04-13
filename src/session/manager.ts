import type { App } from "@slack/bolt";
import type { Config } from "../config.ts";
import type { SpawnHandle, SpawnResult, StreamEvent } from "../claude/types.ts";
import type { SlackMessageEvent, SlackFileAttachment } from "../slack/events.ts";
import type { SessionStore } from "./store/interface.ts";
import type { ThreadSession } from "./types.ts";
import type { AgentRouter } from "../agents/router.ts";
import type { WorktreeManager } from "../worktree/manager.ts";
import { createSession } from "./types.ts";
import { spawnClaude as defaultSpawnClaude } from "../claude/spawner.ts";
import { withTimeout } from "../lifecycle/timeout.ts";
import { buildPromptPreamble } from "../slack/thread-context.ts";
import { downloadSlackFiles } from "../slack/files.ts";
import { log as _log } from "../logger.ts";

type SpawnClaudeFn = typeof defaultSpawnClaude;

export class SessionManager {
  private store: SessionStore;
  private config: Config;
  private handles = new Map<string, SpawnHandle>();
  private seenMessages = new Set<string>();
  private spawnClaude: SpawnClaudeFn;

  slackApp?: App;
  botUserId?: string;
  agentRouter?: AgentRouter;
  worktreeManager?: WorktreeManager;
  onResponse?: (session: ThreadSession, response: string) => void;
  onEvent?: (session: ThreadSession, event: StreamEvent) => void;
  onMessageBuffered?: (event: SlackMessageEvent) => void;
  onError?: (session: ThreadSession, error: string | null) => void;
  onCommandResponse?: (event: SlackMessageEvent, response: string) => void;

  constructor(store: SessionStore, config: Config, spawnClaude?: SpawnClaudeFn) {
    this.store = store;
    this.config = config;
    this.spawnClaude = spawnClaude ?? defaultSpawnClaude;
  }

  async handleMessage(event: SlackMessageEvent): Promise<void> {
    // Deduplicate: Slack fires both `message` and `app_mention` for @mentions
    if (this.seenMessages.has(event.ts)) return;
    this.seenMessages.add(event.ts);
    // Prevent unbounded growth — old ts values are never needed again
    if (this.seenMessages.size > 1000) {
      const entries = [...this.seenMessages];
      for (let i = 0; i < 500; i++) this.seenMessages.delete(entries[i]);
    }

    let session = await this.store.get(event.threadId);

    if (!session) {
      session = createSession(event.threadId, event.channel);
      await this.store.set(event.threadId, session);
    }

    if (event.command) {
      const handled = await this.handleCommand(session, event);
      if (handled) return;
    }

    if (session.status === "busy") {
      session.pendingMessages.push({
        user: event.user,
        text: event.text,
        ts: event.ts,
        command: event.command ?? undefined,
      });
      await this.store.set(session.threadId, session);
      this.onMessageBuffered?.(event);
      return;
    }

    session.status = "busy";
    session.lastActivity = Date.now();
    await this.store.set(session.threadId, session);

    this.runClaudeWithAgent(session, event.text, event.ts, event.files);
  }

  async getSession(threadId: string): Promise<ThreadSession | undefined> {
    return this.store.get(threadId);
  }

  async resetSession(threadId: string): Promise<void> {
    const session = await this.store.get(threadId);
    if (session && session.status === "busy") {
      const handle = this.handles.get(threadId);
      if (handle) {
        handle.kill();
        this.handles.delete(threadId);
      }
    }
    await this.store.delete(threadId);
  }

  private async handleCommand(
    session: ThreadSession,
    event: SlackMessageEvent,
  ): Promise<boolean> {
    switch (event.command) {
      case "reset": {
        await this.resetSession(session.threadId);
        this.onCommandResponse?.(event, "Session reset.");
        return true;
      }

      case "status": {
        const ago = session.lastActivity
          ? `${Math.round((Date.now() - session.lastActivity) / 1000)}s ago`
          : "never";
        const lines = [
          `*Status:* ${session.status}`,
          `*Agent:* ${session.agentType ?? "default"}`,
          `*Repo:* ${session.targetRepo ?? "none"}`,
          `*Worktree:* ${session.worktreePath ?? "none"}`,
          `*Last activity:* ${ago}`,
          `*Pending messages:* ${session.pendingMessages.length}`,
        ];
        this.onCommandResponse?.(event, lines.join("\n"));
        return true;
      }

      case "help": {
        const helpText = [
          "*Commands:*",
          "`!build` — Build agent (continues to Claude)",
          "`!frontend` — Frontend agent (continues to Claude)",
          "`!review` — Review agent (continues to Claude)",
          "`!architect` — Architect agent (continues to Claude)",
          "`!repo <name>` — Set target repository",
          "`!branch <ref>` — Set base branch ref",
          "`!reset` — Reset session",
          "`!status` — Show session status",
          "`!quiet` — Minimal output",
          "`!normal` — Normal output",
          "`!verbose` — Verbose output",
          "`!adhoc <text>` — Add ad-hoc item to calendar",
          "`!bugs <text>` — Add bug item to calendar",
          "`!help` — Show this help",
        ].join("\n");
        this.onCommandResponse?.(event, helpText);
        return true;
      }

      case "quiet": {
        session.verbosity = "quiet";
        await this.store.set(session.threadId, session);
        this.onCommandResponse?.(event, "Quiet mode.");
        return true;
      }

      case "verbose": {
        session.verbosity = "verbose";
        await this.store.set(session.threadId, session);
        this.onCommandResponse?.(event, "Verbose mode.");
        return true;
      }

      case "normal": {
        session.verbosity = "normal";
        await this.store.set(session.threadId, session);
        this.onCommandResponse?.(event, "Normal mode.");
        return true;
      }

      case "build":
      case "frontend":
      case "review":
      case "architect": {
        session.agentType = event.command;
        await this.store.set(session.threadId, session);
        return false;
      }

      case "repo": {
        const repoName = event.text.trim();
        const match = this.config.repos.find((r) => r.name === repoName);
        if (match) {
          session.targetRepo = match.name;
          await this.store.set(session.threadId, session);
          this.onCommandResponse?.(event, `Repository set to *${match.name}*.`);
        } else {
          const available = this.config.repos.map((r) => r.name).join(", ");
          this.onCommandResponse?.(
            event,
            `Unknown repo "${repoName}". Available: ${available || "none configured"}`,
          );
        }
        return true;
      }

      case "branch": {
        const ref = event.text.trim();
        session.baseRef = ref;
        await this.store.set(session.threadId, session);
        this.onCommandResponse?.(event, `Base ref set to *${ref}*.`);
        return true;
      }

      case "adhoc":
      case "bugs": {
        const itemType = event.command === "bugs" ? "bug" : "ad-hoc";
        const itemText = event.text.trim();
        if (!itemText) {
          this.onCommandResponse?.(event, `Usage: \`!${event.command} <description>\``);
          return true;
        }
        session.model = "haiku";
        await this.store.set(session.threadId, session);
        const today = new Date();
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        const todayStr = today.toISOString().split("T")[0];
        const tomorrowStr = tomorrow.toISOString().split("T")[0];

        event.text = [
          `Add a ${itemType} item to the Google Calendar event titled "Bugs, Ad-hocs & PR reviews overflow".`,
          ``,
          `Item to add: ${itemText}`,
          ``,
          `Steps:`,
          `1. Determine from the item text whether this is for today (${todayStr}) or tomorrow (${tomorrowStr}). If the text mentions "tomorrow", use tomorrow's date. Otherwise default to today.`,
          `2. Use gcal_list_events to find the event on that date (search q="Bugs, Ad-hocs & PR reviews overflow", set timeMin/timeMax to cover that day).`,
          `3. Use gcal_get_event to read the current description.`,
          `4. Append a new bullet to the description: "- [${itemType.toUpperCase()}] ${itemText}"`,
          `5. Use gcal_update_event to save the updated description. Only update the description field — do not change other fields. Set sendUpdates to "none".`,
          `6. Reply with a brief confirmation: what was added and to which date's event.`,
        ].join("\n");
        return false;
      }

      default:
        return false;
    }
  }

  private async runClaudeWithAgent(
    session: ThreadSession,
    prompt: string,
    latestTs?: string,
    files?: SlackFileAttachment[],
  ): Promise<void> {
    try {
      // Inject identity + thread context so Claude knows who it is and what was said
      if (this.slackApp && latestTs) {
        const preamble = await buildPromptPreamble(
          this.slackApp,
          session.channel,
          session.threadId,
          latestTs,
          this.botUserId,
        );
        prompt = `${preamble}\n\n${prompt}`;
      }

      // Download image files from Slack and append their paths to the prompt
      if (files && files.length > 0) {
        try {
          const localPaths = await downloadSlackFiles(
            files,
            session.threadId,
            this.config.slack.botToken,
          );
          if (localPaths.length > 0) {
            const pathList = localPaths.map((p) => `- ${p}`).join("\n");
            prompt += `\n\nThe user shared images. They are saved at these paths — use the Read tool to view them:\n${pathList}`;
          }
        } catch (err) {
          console.error("[manager] Failed to download Slack files:", err);
        }
      }

      // Compose agent system prompt
      if (session.agentType && this.agentRouter) {
        session.systemPrompt =
          (await this.agentRouter.composeSystemPrompt(session)) ?? null;
        await this.store.set(session.threadId, session);
      }

      // Create worktree for build/frontend agents if needed
      if (
        this.worktreeManager &&
        session.targetRepo &&
        !session.worktreePath &&
        (session.agentType === "build" || session.agentType === "frontend")
      ) {
        try {
          session.worktreePath = await this.worktreeManager.createWorktree(
            session.targetRepo,
            session.threadId,
            session.baseRef ?? undefined,
          );
          await this.store.set(session.threadId, session);
        } catch (err) {
          console.error("[manager] Failed to create worktree:", err);
          // Continue without worktree — spawner falls back to cwd
        }
      }

      // Resolve target repo path for cwd fallback (decision 4: cwd → target repo)
      let targetRepoCwd: string | undefined;
      if (session.targetRepo) {
        const repo = this.config.repos.find((r) => r.name === session.targetRepo);
        if (repo) targetRepoCwd = repo.path;
      }

      // We don't log the prompt to avoid spamming the logs. unless we are debugging it
      // log.info("prompt", `thread=${session.threadId} cwd=${targetRepoCwd ?? session.worktreePath ?? "junior"}\n--- PROMPT START ---\n${prompt}\n--- PROMPT END ---`);

      const rawHandle = this.spawnClaude(session, prompt, this.config.claude, targetRepoCwd, this.config.slack.botToken);
      const handle = withTimeout(rawHandle, this.config.claude.timeoutMs, () => {
        console.warn(`[manager] Claude timed out for thread ${session.threadId}`);
      });
      this.handles.set(session.threadId, handle);
      session.pid = handle.pid;

      handle.onEvent((event: StreamEvent) => {
        if (event.type === "system" && event.subtype === "init") {
          session.sessionId = event.session_id;
        }
        this.onEvent?.(session, event);
      });

      handle.result.then(
        (result: SpawnResult) => this.onRunComplete(session, result),
        (err: unknown) => this.onRunComplete(session, {
          sessionId: null,
          response: "",
          events: [],
          exitCode: null,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    } catch (err) {
      // Agent prompt composition or worktree creation failed fatally
      session.status = "idle";
      session.lastError = {
        type: "setup",
        message: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
      };
      await this.store.set(session.threadId, session);
      this.onError?.(session, session.lastError.message);
    }
  }

  private async onRunComplete(
    session: ThreadSession,
    result: SpawnResult,
  ): Promise<void> {
    this.handles.delete(session.threadId);
    session.pid = null;

    if (result.sessionId) {
      session.sessionId = result.sessionId;
    }

    if (result.error) {
      session.lastError = {
        type: "spawn",
        message: result.error,
        timestamp: Date.now(),
      };
      this.onError?.(session, result.error);
    }

    if (result.response) {
      this.onResponse?.(session, result.response);
    }

    if (session.pendingMessages.length > 0) {
      const combined = session.pendingMessages
        .map((m) => `[${m.user}]: ${m.text}`)
        .join("\n");
      session.pendingMessages = [];
      session.status = "draining";
      await this.store.set(session.threadId, session);
      this.runClaudeWithAgent(session, combined).catch((err) => {
        console.error("[manager] Drain failed:", err);
        session.status = "idle";
        this.store.set(session.threadId, session);
      });
    } else {
      session.status = "idle";
      await this.store.set(session.threadId, session);
    }
  }
}
