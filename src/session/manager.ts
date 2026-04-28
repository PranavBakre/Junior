import type { App } from "@slack/bolt";
import type { Config } from "../config.ts";
import type { SpawnHandle, SpawnResult, StreamEvent } from "../claude/types.ts";
import type {
  SlackMessageEvent,
  SlackFileAttachment,
} from "../slack/events.ts";
import type { SessionStore } from "./store/interface.ts";
import type {
  AgentIdentity,
  AgentSession,
  PendingMessage,
  ThreadSession,
} from "./types.ts";
import type { AgentRouter } from "../agents/router.ts";
import type { WorktreeManager } from "../worktree/manager.ts";
import { createSession } from "./types.ts";
import { spawnClaude as defaultSpawnClaude } from "../claude/spawner.ts";
import { identityForAgent } from "../support/agents.ts";
import { withTimeout } from "../lifecycle/timeout.ts";
import {
  buildPromptPreamble,
  buildWorkspaceBlock,
  resolveSlackMentions,
  type WorkspaceContext,
} from "../slack/thread-context.ts";
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

  constructor(
    store: SessionStore,
    config: Config,
    spawnClaude?: SpawnClaudeFn,
  ) {
    this.store = store;
    this.config = config;
    this.spawnClaude = spawnClaude ?? defaultSpawnClaude;
  }

  async handleMessage(event: SlackMessageEvent): Promise<void> {
    await this.handleLeadMessage(event);
  }

  async handleAgentMessage(
    event: SlackMessageEvent,
    agentName: string,
  ): Promise<void> {
    if (agentName === "lead") {
      await this.handleLeadMessage(event);
      return;
    }

    const dedupeKey = event.dedupeKey ?? `${event.ts}:${agentName}`;
    if (this.seenMessages.has(dedupeKey)) return;
    this.rememberSeenMessage(dedupeKey);

    const session = await this.getOrCreateSession(event);
    const agentSession = this.getOrCreateAgentSession(session, agentName);

    if (agentSession.status === "busy") {
      agentSession.pendingMessages.push(this.toPendingMessage(event));
      await this.store.set(session.threadId, session);
      this.onMessageBuffered?.(event);
      return;
    }

    agentSession.status = "busy";
    agentSession.lastActivity = Date.now();
    session.lastActivity = agentSession.lastActivity;
    await this.store.set(session.threadId, session);

    this.runClaudeWithAgent(session, event.text, event.ts, event.files, agentName);
  }

  private async handleLeadMessage(event: SlackMessageEvent): Promise<void> {
    // Deduplicate: Slack fires both `message` and `app_mention` for @mentions
    const dedupeKey = event.dedupeKey ?? event.ts;
    if (this.seenMessages.has(dedupeKey)) return;
    this.rememberSeenMessage(dedupeKey);

    const session = await this.getOrCreateSession(event);

    if (event.command) {
      const handled = await this.handleCommand(session, event);
      if (handled) return;
    }

    if (session.status === "busy") {
      session.pendingMessages.push({
        ...this.toPendingMessage(event),
      });
      await this.store.set(session.threadId, session);
      this.onMessageBuffered?.(event);
      return;
    }

    session.status = "busy";
    session.lastActivity = Date.now();
    await this.store.set(session.threadId, session);

    this.runClaudeWithAgent(session, event.text, event.ts, event.files, "lead");
  }

  async getSession(threadId: string): Promise<ThreadSession | undefined> {
    return this.store.get(threadId);
  }

  async resetSession(threadId: string): Promise<void> {
    const session = await this.store.get(threadId);
    if (session) {
      for (const [key, handle] of this.handles) {
        if (!key.startsWith(`${threadId}:`)) continue;
        handle.kill();
        this.handles.delete(key);
      }
    }
    await this.store.delete(threadId);
  }

  private async handleCommand(
    session: ThreadSession,
    event: SlackMessageEvent,
  ): Promise<boolean> {
    switch (event.command) {
      case "cancel": {
        let killed = 0;
        for (const [key, handle] of this.handles) {
          if (!key.startsWith(`${session.threadId}:`)) continue;
          handle.kill();
          this.handles.delete(key);
          killed++;
        }
        session.status = "idle";
        session.pid = null;
        session.pendingMessages = [];
        for (const agentSession of Object.values(session.agentSessions ?? {})) {
          agentSession.status = "idle";
          agentSession.pid = null;
          agentSession.pendingMessages = [];
        }
        await this.store.set(session.threadId, session);
        this.onCommandResponse?.(
          event,
          killed === 0 ? "Nothing running." : `Cancelled (${killed} process${killed === 1 ? "" : "es"}).`,
        );
        return true;
      }

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
          "`!cancel` — Kill running process, keep session",
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
        let itemText = event.text.trim();

        // Parse optional "today"/"tomorrow" prefix as date qualifier
        const today = new Date();
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        let targetDate: Date;
        if (/^tomorrow\b/i.test(itemText)) {
          targetDate = tomorrow;
          itemText = itemText.replace(/^tomorrow\s*/i, "").trim();
        } else {
          targetDate = today;
          itemText = itemText.replace(/^today\s*/i, "").trim();
        }

        session.model = "haiku";
        session.cwd = "/tmp/junior-utility";
        await this.store.set(session.threadId, session);
        const dateStr = targetDate.toISOString().split("T")[0];
        const fromThread = !itemText;

        const itemInstruction = fromThread
          ? `Summarize the thread conversation above into a concise one-line ${itemType} description.`
          : `Item to add: ${itemText}`;
        const bulletInstruction = fromThread
          ? `Append a new bullet to the description with your summary: "- [${itemType.toUpperCase()}] <your one-line summary>"`
          : `Append a new bullet to the description: "- [${itemType.toUpperCase()}] ${itemText}"`;

        event.text = [
          `TASK: Add a ${itemType} item to Google Calendar. Do NOT read any code files. Only use Google Calendar tools.`,
          ``,
          `Event: "Bugs, Ad-hocs & PR reviews overflow" on ${dateStr}`,
          itemInstruction,
          ``,
          `Steps:`,
          `1. gcal_list_events: q="Bugs, Ad-hocs & PR reviews overflow", timeMin="${dateStr}T00:00:00", timeMax="${dateStr}T23:59:59"`,
          `2. gcal_get_event: read current description`,
          `3. gcal_update_event: ${bulletInstruction}. Only update description. sendUpdates="none"`,
          `4. Reply with a one-line confirmation.`,
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
    agentName: string = "lead",
  ): Promise<void> {
    try {
      const isLead = agentName === "lead";
      const agentSession = isLead
        ? null
        : this.getOrCreateAgentSession(session, agentName);
      const agentIdentity = identityForAgent(agentName);
      const runSession = this.buildRunSession(session, agentName, agentIdentity);

      // Resolve target repo before building the preamble so workspace info can be injected.
      let targetRepo: { name: string; path: string } | undefined;
      if (session.targetRepo) {
        const repo = this.config.repos.find(
          (r) => r.name === session.targetRepo,
        );
        if (repo) targetRepo = { name: repo.name, path: repo.path };
      }

      // Always create a worktree when a target repo is set — Junior must never
      // edit the shared origin repo path directly. (Previously this was gated on
      // agentType === "build" || "frontend", which let other agents cwd into the
      // real repo and modify it.)
      if (
        this.worktreeManager &&
        targetRepo &&
        !session.worktreePath
      ) {
        try {
          session.worktreePath = await this.worktreeManager.createWorktree(
            targetRepo.name,
            session.threadId,
            session.baseRef ?? undefined,
          );
          await this.store.set(session.threadId, session);
        } catch (err) {
          _log.warn(
            "manager",
            `worktree.create.fail thread=${session.threadId} repo=${targetRepo.name} err=${err instanceof Error ? err.message : String(err)}`,
          );
          // Don't silently cwd into the real repo — clear targetRepo for this run
          // so the spawner falls back to junior's project root instead.
          targetRepo = undefined;
        }
      }

      // Build workspace context for the preamble if we have a worktree.
      const workspace: WorkspaceContext | null =
        session.worktreePath && targetRepo && this.worktreeManager
          ? {
              worktreePath: session.worktreePath,
              repoName: targetRepo.name,
              repoPath: targetRepo.path,
              branchName: this.worktreeManager.getBranchName(session.threadId),
            }
          : null;

      // Build the prompt. On the first turn (no sessionId yet), inject the full
      // preamble (identity, slack-context, workspace, thread history). On resumed
      // turns, --resume already carries identity/context/history — sending them
      // again duplicates tokens and pollutes the conversation. Keep just the
      // workspace block (cheap insurance for the worktree safety rule).
      if (this.slackApp && latestTs) {
        const isFirstTurn = !runSession.sessionId;
        const readablePrompt = await resolveSlackMentions(this.slackApp, prompt);
        if (isFirstTurn) {
          const preamble = await buildPromptPreamble(
            this.slackApp,
            session.channel,
            session.threadId,
            latestTs,
            this.botUserId,
            workspace,
          );
          prompt = `${preamble}\n\n${readablePrompt}`;
        } else {
          const workspaceBlock = buildWorkspaceBlock(workspace);
          prompt = workspaceBlock
            ? `${workspaceBlock}\n\n${readablePrompt}`
            : readablePrompt;
        }
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
      if (runSession.agentType && this.agentRouter) {
        const composed =
          (await this.agentRouter.composeSystemPrompt(runSession)) ?? null;
        runSession.systemPrompt = this.withAgentIdentityPrompt(
          composed,
          agentName,
          agentIdentity,
        );
        if (isLead) {
          session.systemPrompt = runSession.systemPrompt;
        }
        await this.store.set(session.threadId, session);
      }

      // cwd fallback: only used when no worktree exists. With the always-worktree
      // policy above, this only fires for read-only/discussion threads with no
      // targetRepo — never inside the shared origin repo.
      const targetRepoCwd: string | undefined = session.worktreePath
        ? undefined
        : targetRepo?.path;

      const agentStateBlock = this.buildAgentStateBlock(session);
      if (agentStateBlock) {
        prompt = `${agentStateBlock}\n\n${prompt}`;
      }

      // We don't log the prompt to avoid spamming the logs. unless we are debugging it
      // log.info("prompt", `thread=${session.threadId} cwd=${targetRepoCwd ?? session.worktreePath ?? "junior"}\n--- PROMPT START ---\n${prompt}\n--- PROMPT END ---`);

      const rawHandle = this.spawnClaude(
        runSession,
        prompt,
        this.config.claude,
        targetRepoCwd,
        this.config.slack.botToken,
        agentIdentity,
      );
      const handle = withTimeout(
        rawHandle,
        this.config.claude.timeoutMs,
        () => {
          console.warn(
            `[manager] Claude timed out for thread ${session.threadId}`,
          );
        },
      );
      const handleKey = this.handleKey(session.threadId, agentName);
      this.handles.set(handleKey, handle);
      if (isLead) {
        session.pid = handle.pid;
      } else if (agentSession) {
        agentSession.pid = handle.pid;
      }

      handle.onEvent((event: StreamEvent) => {
        if (event.type === "system" && event.subtype === "init") {
          if (isLead) {
            session.sessionId = event.session_id;
            session.leadSessionId = event.session_id;
          } else if (agentSession) {
            agentSession.sessionId = event.session_id;
          }
        }
        this.onEvent?.(this.buildRunSession(session, agentName, agentIdentity), event);
      });

      handle.result.then(
        (result: SpawnResult) => this.onRunComplete(session, result, agentName),
        (err: unknown) =>
          this.onRunComplete(session, {
            sessionId: null,
            response: "",
            events: [],
            exitCode: null,
            error: err instanceof Error ? err.message : String(err),
          }, agentName),
      );
    } catch (err) {
      // Agent prompt composition or worktree creation failed fatally
      if (agentName === "lead") {
        session.status = "idle";
      } else {
        const agentSession = this.getOrCreateAgentSession(session, agentName);
        agentSession.status = "failed";
        agentSession.pid = null;
      }
      session.lastError = {
        type: "setup",
        message: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
      };
      await this.store.set(session.threadId, session);
      this.onError?.(
        this.buildRunSession(session, agentName, identityForAgent(agentName)),
        session.lastError.message,
      );
    }
  }

  private async onRunComplete(
    session: ThreadSession,
    result: SpawnResult,
    agentName: string = "lead",
  ): Promise<void> {
    const isLead = agentName === "lead";
    const agentIdentity = identityForAgent(agentName);
    const agentSession = isLead
      ? null
      : this.getOrCreateAgentSession(session, agentName);
    this.handles.delete(this.handleKey(session.threadId, agentName));
    if (isLead) {
      session.pid = null;
    } else if (agentSession) {
      agentSession.pid = null;
    }

    if (result.sessionId) {
      if (isLead) {
        session.sessionId = result.sessionId;
        session.leadSessionId = result.sessionId;
      } else if (agentSession) {
        agentSession.sessionId = result.sessionId;
      }
    }

    if (result.error) {
      session.lastError = {
        type: "spawn",
        message: result.error,
        timestamp: Date.now(),
      };
      if (agentSession) agentSession.status = "failed";
      this.onError?.(
        this.buildRunSession(session, agentName, agentIdentity),
        result.error,
      );
    }

    if (result.response) {
      this.onResponse?.(
        this.buildRunSession(session, agentName, agentIdentity),
        result.response,
      );
    }

    const pendingMessages = isLead
      ? session.pendingMessages
      : (agentSession?.pendingMessages ?? []);

    if (pendingMessages.length > 0) {
      const combined = pendingMessages
        .map((m) => `[${m.user}]: ${m.text}`)
        .join("\n");
      if (isLead) {
        session.pendingMessages = [];
        session.status = "draining";
      } else if (agentSession) {
        agentSession.pendingMessages = [];
        agentSession.status = "busy";
      }
      await this.store.set(session.threadId, session);
      this.runClaudeWithAgent(session, combined, undefined, undefined, agentName).catch((err) => {
        console.error("[manager] Drain failed:", err);
        if (isLead) {
          session.status = "idle";
        } else if (agentSession) {
          agentSession.status = "failed";
        }
        this.store.set(session.threadId, session);
      });
    } else {
      if (isLead) {
        session.status = "idle";
      } else if (agentSession) {
        agentSession.status = result.error ? "failed" : "done";
        agentSession.lastActivity = Date.now();
      }
      await this.store.set(session.threadId, session);
    }
  }

  private async getOrCreateSession(
    event: SlackMessageEvent,
  ): Promise<ThreadSession> {
    let session = await this.store.get(event.threadId);

    if (!session) {
      session = createSession(
        event.threadId,
        event.channel,
        this.config.session.defaultVerbosity,
      );
      // Apply channel-level default agent type (e.g. #bugs-backlog → lead)
      const channelDefault = this.config.channelDefaults[event.channel];
      if (channelDefault) {
        session.agentType = channelDefault.agentType;
      }
      await this.store.set(event.threadId, session);
    }

    session.leadSessionId ??= session.sessionId;
    session.agentSessions ??= {};
    return session;
  }

  private getOrCreateAgentSession(
    session: ThreadSession,
    agentName: string,
  ): AgentSession {
    session.agentSessions ??= {};
    session.agentSessions[agentName] ??= {
      agentName,
      sessionId: null,
      status: "idle",
      pendingMessages: [],
      lastActivity: Date.now(),
      pid: null,
    };
    return session.agentSessions[agentName];
  }

  private buildRunSession(
    session: ThreadSession,
    agentName: string,
    agentIdentity?: AgentIdentity,
  ): ThreadSession {
    if (agentName === "lead") {
      return {
        ...session,
        sessionId: session.leadSessionId ?? session.sessionId,
        activeAgentName: "lead",
        slackIdentity: agentIdentity,
      };
    }

    const agentSession = this.getOrCreateAgentSession(session, agentName);
    return {
      ...session,
      sessionId: agentSession.sessionId,
      agentType: agentName,
      systemPrompt: null,
      status: agentSession.status === "busy" ? "busy" : "idle",
      pendingMessages: agentSession.pendingMessages,
      pid: agentSession.pid,
      lastActivity: agentSession.lastActivity,
      activeAgentName: agentName,
      slackIdentity: agentIdentity,
    };
  }

  private withAgentIdentityPrompt(
    systemPrompt: string | null,
    agentName: string,
    identity?: AgentIdentity,
  ): string | null {
    if (!identity) return systemPrompt;
    const identityPrompt = [
      `You are the persistent "${agentName}" agent in this Slack thread.`,
      `When posting through slack_send_message, pass username="${identity.username}" and icon_emoji="${identity.iconEmoji}".`,
      agentName === "lead"
        ? "Do not append an attribution suffix to your Slack messages."
        : `End every Slack message with "by ${agentName}".`,
    ].join("\n");
    return systemPrompt ? `${systemPrompt}\n\n${identityPrompt}` : identityPrompt;
  }

  private toPendingMessage(event: SlackMessageEvent): PendingMessage {
    return {
      user: event.user,
      text: event.text,
      ts: event.ts,
      command: event.command ?? undefined,
      dedupeKey: event.dedupeKey,
    };
  }

  private buildAgentStateBlock(session: ThreadSession): string | null {
    const agentSessions = Object.values(session.agentSessions ?? {});
    if (agentSessions.length === 0) return null;

    const lines = agentSessions
      .sort((a, b) => a.agentName.localeCompare(b.agentName))
      .map((agentSession) => {
        const pending = agentSession.pendingMessages.length;
        return `- ${agentSession.agentName}: ${agentSession.status}, pending=${pending}`;
      });

    return [
      "<persistent-agent-state>",
      "Current persistent agent sessions for this thread:",
      ...lines,
      "</persistent-agent-state>",
    ].join("\n");
  }

  private rememberSeenMessage(key: string): void {
    this.seenMessages.add(key);
    // Prevent unbounded growth — old ts values are never needed again
    if (this.seenMessages.size > 1000) {
      const entries = [...this.seenMessages];
      for (let i = 0; i < 500; i++) this.seenMessages.delete(entries[i]);
    }
  }

  private handleKey(threadId: string, agentName: string): string {
    return `${threadId}:${agentName}`;
  }
}
