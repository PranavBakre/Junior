import type { App } from "@slack/bolt";
import type { Config } from "../config.ts";
import type { RunnerEvent, SpawnHandle, SpawnResult, SpawnRunnerFn } from "../runners/types.ts";
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
import {
  createSession,
  isImplementedRunnerProvider,
  isRunnerProvider,
} from "./types.ts";
import {
  runnerTimeoutMs,
  sessionProvider,
  spawnRunner as defaultSpawnRunner,
} from "../runners/index.ts";
import { buildDispatchAllowBlock, identityForAgent } from "../support/agents.ts";
import { withTimeout } from "../lifecycle/timeout.ts";
import {
  buildPromptPreamble,
  buildWorkspaceBlock,
  resolveSlackMentions,
  type WorkspaceContext,
} from "../slack/thread-context.ts";
import { DEFAULT_CONTEXT_PROFILE, type AgentContextProfile } from "../agents/loader.ts";
import { downloadSlackFiles } from "../slack/files.ts";
import { log as _log } from "../logger.ts";

export class SessionManager {
  private store: SessionStore;
  private config: Config;
  private handles = new Map<string, SpawnHandle>();
  private seenMessages = new Set<string>();
  private spawnRunner: SpawnRunnerFn;

  slackApp?: App;
  botUserId?: string;
  agentRouter?: AgentRouter;
  worktreeManager?: WorktreeManager;
  onResponse?: (session: ThreadSession, response: string) => void;
  onEvent?: (session: ThreadSession, event: RunnerEvent) => void;
  onMessageBuffered?: (event: SlackMessageEvent) => void;
  onError?: (session: ThreadSession, error: string | null) => void;
  onCommandResponse?: (event: SlackMessageEvent, response: string) => void;
  onReaction?: (event: SlackMessageEvent, emoji: string) => void;

  constructor(
    store: SessionStore,
    config: Config,
    spawnRunner?: SpawnRunnerFn,
  ) {
    this.store = store;
    this.config = config;
    this.spawnRunner = spawnRunner ?? defaultSpawnRunner;
  }

  async handleMessage(event: SlackMessageEvent): Promise<void> {
    await this.runSingleSession(event, "default");
  }

  async handleLeadMessage(event: SlackMessageEvent): Promise<void> {
    await this.runSingleSession(event, "lead");
  }

  async handleAgentMessage(
    event: SlackMessageEvent,
    agentName: string,
  ): Promise<void> {
    if (agentName === "lead") {
      await this.runSingleSession(event, "lead");
      return;
    }
    if (agentName === "default") {
      await this.runSingleSession(event, "default");
      return;
    }

    const dedupeKey = event.dedupeKey ?? `${event.ts}:${agentName}`;
    if (this.seenMessages.has(dedupeKey)) return;
    this.rememberSeenMessage(dedupeKey);

    const session = await this.getOrCreateSession(event);

    if (session.muted) return;

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

    this.runRunnerWithAgent(session, event.text, event.ts, event.files, agentName);
  }

  // Generic single-session path for "default" (any-channel @mentions) and the
  // bug-pipeline "lead" agent. Both run at the top level of the thread session
  // (using session.status / session.sessionId / session.pendingMessages) rather
  // than per-agent state. The only differences are the slack identity, the
  // composed system prompt, and the persistent-agent state block — all keyed
  // off agentName downstream.
  private async runSingleSession(
    event: SlackMessageEvent,
    agentName: "lead" | "default",
  ): Promise<void> {
    // Deduplicate: Slack fires both `message` and `app_mention` for @mentions
    const dedupeKey = event.dedupeKey ?? event.ts;
    if (this.seenMessages.has(dedupeKey)) return;
    this.rememberSeenMessage(dedupeKey);

    const session = await this.getOrCreateSession(event);

    if (event.command) {
      const handled = await this.handleCommand(session, event);
      if (handled) return;
    }

    if (session.muted) return;

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

    this.runRunnerWithAgent(session, event.text, event.ts, event.files, agentName);
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

  /**
   * Reset a single agent's slice of a thread session, leaving other agents'
   * state intact. Returns true if the agent had state to clear.
   *
   * "lead"/"default" live on the parent ThreadSession (sessionId,
   * leadSessionId, pendingMessages); everything else lives in
   * agentSessions[agentName].
   */
  async resetAgent(threadId: string, agentName: string): Promise<boolean> {
    const session = await this.store.get(threadId);
    if (!session) return false;

    const handleKey = this.handleKey(threadId, agentName);
    const handle = this.handles.get(handleKey);
    if (handle) {
      handle.kill();
      this.handles.delete(handleKey);
    }

    let touched = false;
    if (agentName === "lead" || agentName === "default") {
      if (session.sessionId || session.leadSessionId || session.pendingMessages.length > 0 || session.status !== "idle") {
        touched = true;
      }
      session.sessionId = null;
      session.leadSessionId = null;
      session.pendingMessages = [];
      session.status = "idle";
      session.pid = null;
    } else if (session.agentSessions?.[agentName]) {
      delete session.agentSessions[agentName];
      touched = true;
    }

    await this.store.set(threadId, session);
    return touched;
  }

  async isAdmin(userId: string): Promise<boolean> {
    const envAdmin = this.config.adminSlackUserId;
    if (envAdmin && userId === envAdmin) return true;
    const extras = await this.store.extraAdmins();
    if (extras.has(userId)) return true;
    // Open-mode (local dev) only when NEITHER tier is configured. Without
    // this guard, an env-var misfire in prod that unsets ADMIN_SLACK_USER_ID
    // would silently promote everyone AND ignore the populated admins table.
    return !envAdmin && extras.size === 0;
  }

  /**
   * Returns true if the user is denied (and a ❌ reaction was queued).
   * Caller should `return true` from the command handler to short-circuit.
   */
  private async denyIfNotAdmin(event: SlackMessageEvent): Promise<boolean> {
    if (await this.isAdmin(event.user)) return false;
    this.onReaction?.(event, "x");
    return true;
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
        // Gate on admin BEFORE inspecting args. Otherwise a non-admin sending
        // bare `!reset` gets the usage hint posted to the thread, contradicting
        // the documented "silent ❌ reaction, no thread reply" promise — and
        // leaks the gating model to anyone probing.
        if (await this.denyIfNotAdmin(event)) return true;
        const arg = event.text.trim();
        if (!arg) {
          this.onCommandResponse?.(
            event,
            "Usage: `!reset <agent>` (e.g. `!reset lead`, `!reset reproducer`) or `!reset all` to clear the entire thread session.",
          );
          return true;
        }
        if (arg === "all") {
          await this.resetSession(session.threadId);
          this.onCommandResponse?.(event, "Session reset.");
          return true;
        }
        const touched = await this.resetAgent(session.threadId, arg);
        if (touched) {
          this.onCommandResponse?.(event, `Reset *${arg}*.`);
        } else {
          this.onCommandResponse?.(
            event,
            `No state for *${arg}* in this thread. Nothing to reset.`,
          );
        }
        return true;
      }

      case "status": {
        const ago = session.lastActivity
          ? `${Math.round((Date.now() - session.lastActivity) / 1000)}s ago`
          : "never";
        const lines = [
          `*Status:* ${session.status}`,
          `*Provider:* ${session.provider ?? this.config.runner.provider}`,
          `*Muted:* ${session.muted ? "yes" : "no"}`,
          `*Agent:* ${session.agentType ?? "default"}`,
          `*Default Agent:* ${session.defaultAgent ?? "channel default"}`,
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
          "`!build` — Build agent (continues to runner)",
          "`!frontend` — Frontend agent (continues to runner)",
          "`!review` — Review agent (continues to runner)",
          "`!architect` — Architect agent (continues to runner)",
          "`!repo <name>` — Set target repository",
          "`!branch <ref>` — Set base branch ref",
          "`!agent <junior|lead>` — Set thread default agent",
          "`!provider <claude|opencode>` — Set runner provider for this thread",
          "`!cancel` — Kill running process, keep session",
          "`!reset <agent|all>` — Reset one agent's state, or the whole thread (admin only)",
          "`!status` — Show session status",
          "`!quiet` — Minimal output",
          "`!normal` — Normal output",
          "`!verbose` — Verbose output",
          "`!adhoc <text>` — Add ad-hoc item to calendar",
          "`!bugs <text>` — Add bug item to calendar",
          "`!mute` — Stop responding until !unmute (admin only)",
          "`!unmute` — Resume responding (admin only)",
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

      case "agent": {
        const agentName = event.text.trim().toLowerCase();
        if (agentName === "junior" || agentName === "default") {
          session.defaultAgent = "junior";
          await this.store.set(session.threadId, session);
          this.onCommandResponse?.(event, "Thread default set to *Junior*. Future messages will go to Junior instead of the channel default.");
        } else if (agentName === "lead") {
          session.defaultAgent = "lead";
          await this.store.set(session.threadId, session);
          this.onCommandResponse?.(event, "Thread default set to *Lead*. Future messages will go to the support lead.");
        } else {
          this.onCommandResponse?.(event, `Unknown agent "${agentName}". Use \`!agent junior\` or \`!agent lead\`.`);
        }
        return true;
      }

      case "provider": {
        const provider = event.text.trim().toLowerCase();
        if (isRunnerProvider(provider) && !isImplementedRunnerProvider(provider)) {
          this.onCommandResponse?.(
            event,
            `Provider *${provider}* is planned but not yet implemented. Use \`!provider claude\` or \`!provider opencode\`.`,
          );
          return true;
        }
        if (!isImplementedRunnerProvider(provider)) {
          this.onCommandResponse?.(
            event,
            `Unknown provider "${provider}". Use \`!provider claude\` or \`!provider opencode\`.`,
          );
          return true;
        }

        if (session.status !== "idle") {
          this.onCommandResponse?.(
            event,
            "Cannot change provider while a runner is active. Use `!cancel` first.",
          );
          return true;
        }

        const currentProvider = session.provider ?? this.config.runner.provider;
        // A native session can live in any of three slots: the thread-level
        // sessionId, the lead session id, or any persistent agent session
        // (reproducer/thinker/lead/etc). Switching provider while ANY of
        // these is set leaves mixed-provider state in one thread — the new
        // provider drives fresh dispatches while existing agents continue
        // resuming against the old provider. Block all three.
        const hasAgentSession = Object.values(session.agentSessions ?? {}).some(
          (a) => a.sessionId,
        );
        const hasNativeSession = Boolean(
          session.sessionId || session.leadSessionId || hasAgentSession,
        );
        if (hasNativeSession && currentProvider !== provider) {
          this.onCommandResponse?.(
            event,
            `This thread already has a ${currentProvider} session. Run \`!reset all\` before switching to *${provider}*.`,
          );
          return true;
        }

        session.provider = provider;
        await this.store.set(session.threadId, session);
        this.onCommandResponse?.(event, `Runner provider set to *${provider}*.`);
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

      case "mute": {
        if (await this.denyIfNotAdmin(event)) return true;
        session.muted = true;
        await this.store.set(session.threadId, session);
        this.onCommandResponse?.(event, "Muted. I'll stop responding until you `!unmute`.");
        return true;
      }

      case "unmute": {
        if (await this.denyIfNotAdmin(event)) return true;
        session.muted = false;
        await this.store.set(session.threadId, session);
        this.onCommandResponse?.(event, "Unmuted.");
        return true;
      }

      default:
        return false;
    }
  }

  private async runRunnerWithAgent(
    session: ThreadSession,
    prompt: string,
    latestTs: string | undefined,
    files: SlackFileAttachment[] | undefined,
    agentName: string,
  ): Promise<void> {
    const isTopLevel = agentName === "lead" || agentName === "default";
    try {
      const agentSession = isTopLevel
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

      // For bug-pipeline threads, worktreePaths (multi-repo) takes precedence.
      const worktreePaths =
        session.worktreePaths && Object.keys(session.worktreePaths).length > 0
          ? session.worktreePaths
          : undefined;

      // Resolve the agent definition early so its declared context profile
      // gates the preamble. Default agent (no .md) and missing-flag cases
      // fall back to DEFAULT_CONTEXT_PROFILE (all blocks on).
      const agentDefinition = this.agentRouter
        ? await this.agentRouter.resolveAgent(runSession)
        : null;
      const contextProfile: AgentContextProfile =
        agentDefinition?.context ?? DEFAULT_CONTEXT_PROFILE;

      // Build the prompt. On the first turn (no sessionId yet), inject the
      // preamble blocks the agent asked for. On resumed turns, --resume already
      // carries identity/context/history — keep just the workspace block (cheap
      // insurance for the worktree safety rule), and only if the agent wants
      // the workspace context at all.
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
            worktreePaths,
            this.config.repos,
            contextProfile,
          );
          prompt = preamble ? `${preamble}\n\n${readablePrompt}` : readablePrompt;
        } else if (contextProfile.workspace) {
          const workspaceBlock = buildWorkspaceBlock(
            workspace,
            worktreePaths,
            this.config.repos,
            session.threadId,
          );
          prompt = workspaceBlock
            ? `${workspaceBlock}\n\n${readablePrompt}`
            : readablePrompt;
        } else {
          prompt = readablePrompt;
        }
      }

      // Download image files from Slack and append their paths to the prompt
      let imagePaths: string[] = [];
      if (files && files.length > 0) {
        try {
          imagePaths = await downloadSlackFiles(
            files,
            session.threadId,
            this.config.slack.botToken,
          );
          if (imagePaths.length > 0) {
            const pathList = imagePaths.map((p) => `- ${p}`).join("\n");
            prompt += `\n\nThe user shared images. They are saved at these paths — use the Read tool to view them:\n${pathList}`;
          }
        } catch (err) {
          console.error("[manager] Failed to download Slack files:", err);
        }
      }

      // Compose agent system prompt. Note: composeSystemPrompt now returns
      // the common preamble even when no agent .md resolves (e.g. the
      // "default" agent has no definition file but should still receive
      // junior's invariants like the merge-workflow rules).
      if (this.agentRouter) {
        const composed =
          (await this.agentRouter.composeSystemPrompt(runSession)) ?? null;
        runSession.systemPrompt = this.withAgentIdentityPrompt(
          composed,
          agentName,
          agentIdentity,
        );
        if (isTopLevel) {
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

      if (contextProfile.agentState) {
        const agentStateBlock = this.buildAgentStateBlock(session);
        if (agentStateBlock) {
          prompt = `${agentStateBlock}\n\n${prompt}`;
        }
      }

      // We don't log the prompt to avoid spamming the logs. unless we are debugging it
      // log.info("prompt", `thread=${session.threadId} cwd=${targetRepoCwd ?? session.worktreePath ?? "junior"}\n--- PROMPT START ---\n${prompt}\n--- PROMPT END ---`);

      const rawHandle = this.spawnRunner(
        runSession,
        prompt,
        this.config,
        targetRepoCwd,
        this.config.slack.botToken,
        agentIdentity,
        imagePaths,
      );
      const provider = sessionProvider(runSession, this.config);
      const handle = withTimeout(
        rawHandle,
        runnerTimeoutMs(this.config, provider),
        () => {
          console.warn(
            `[manager] ${provider} timed out for thread ${session.threadId}`,
          );
        },
      );
      const handleKey = this.handleKey(session.threadId, agentName);
      this.handles.set(handleKey, handle);
      if (isTopLevel) {
        session.pid = handle.pid;
      } else if (agentSession) {
        agentSession.pid = handle.pid;
      }

      handle.onEvent((event: RunnerEvent) => {
        if (event.type === "init") {
          if (isTopLevel) {
            session.sessionId = event.sessionId;
            session.leadSessionId = event.sessionId;
            session.provider = event.provider;
          } else if (agentSession) {
            agentSession.sessionId = event.sessionId;
            agentSession.provider = event.provider;
          }
        }
        this.onEvent?.(this.buildRunSession(session, agentName, agentIdentity), event);
      });

      handle.result.then(
        (result: SpawnResult) => this.onRunComplete(session, result, agentName, handle),
        (err: unknown) =>
          this.onRunComplete(session, {
            provider,
            sessionId: null,
            response: "",
            events: [],
            exitCode: null,
            error: err instanceof Error ? err.message : String(err),
          }, agentName, handle),
      );
    } catch (err) {
      // Agent prompt composition or worktree creation failed fatally
      if (isTopLevel) {
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
    agentName: string,
    ownHandle?: SpawnHandle,
  ): Promise<void> {
    const isTopLevel = agentName === "lead" || agentName === "default";
    const agentIdentity = identityForAgent(agentName);
    const handleKey = this.handleKey(session.threadId, agentName);

    // If our handle no longer owns the slot, this run was killed by !reset
    // (handle deleted from map) or replaced by a newer spawn. Either way,
    // persisting our stale sessionId / status would clobber authoritative
    // state — bail without writing anything. Also skip onResponse: a discarded
    // run shouldn't post its final message to Slack.
    if (ownHandle && this.handles.get(handleKey) !== ownHandle) {
      return;
    }
    this.handles.delete(handleKey);

    // Refetch the authoritative session before mutating. The `session` we hold
    // is a snapshot from spawn time — long-running agents can be minutes stale.
    // Persisting it whole would clobber writes made by other agents on the same
    // thread while this one was running. Fall back to the snapshot only if the
    // row was deleted (e.g. !reset during the run).
    const fresh = (await this.store.get(session.threadId)) ?? session;
    const agentSession = isTopLevel
      ? null
      : this.getOrCreateAgentSession(fresh, agentName);

    if (isTopLevel) {
      fresh.pid = null;
    } else if (agentSession) {
      agentSession.pid = null;
    }

    if (result.sessionId) {
      if (isTopLevel) {
        fresh.sessionId = result.sessionId;
        fresh.leadSessionId = result.sessionId;
        fresh.provider = result.provider;
      } else if (agentSession) {
        agentSession.sessionId = result.sessionId;
        agentSession.provider = result.provider;
      }
    }

    if (result.error) {
      fresh.lastError = {
        type: "spawn",
        message: result.error,
        timestamp: Date.now(),
      };
      if (agentSession) agentSession.status = "failed";
      this.onError?.(
        this.buildRunSession(fresh, agentName, agentIdentity),
        result.error,
      );
    }

    if (result.response) {
      this.onResponse?.(
        this.buildRunSession(fresh, agentName, agentIdentity),
        result.response,
      );
    }

    const pendingMessages = isTopLevel
      ? fresh.pendingMessages
      : (agentSession?.pendingMessages ?? []);

    if (pendingMessages.length > 0 && fresh.muted) {
      // Thread was muted mid-turn — discard buffered messages, don't drain.
      if (isTopLevel) {
        fresh.pendingMessages = [];
        fresh.status = "idle";
      } else if (agentSession) {
        agentSession.pendingMessages = [];
        agentSession.status = "idle";
      }
      await this.store.set(fresh.threadId, fresh);
    } else if (pendingMessages.length > 0) {
      const combined = pendingMessages
        .map((m) => `[${m.user}]: ${m.text}`)
        .join("\n");
      if (isTopLevel) {
        fresh.pendingMessages = [];
        fresh.status = "draining";
      } else if (agentSession) {
        agentSession.pendingMessages = [];
        agentSession.status = "busy";
      }
      await this.store.set(fresh.threadId, fresh);
      this.runRunnerWithAgent(fresh, combined, undefined, undefined, agentName).catch(async (err) => {
        console.error("[manager] Drain failed:", err);
        // Refetch again — the failed drain may have run minutes after the
        // initial drain persist, and other agents may have updated the row.
        const drainFresh = (await this.store.get(fresh.threadId)) ?? fresh;
        if (isTopLevel) {
          drainFresh.status = "idle";
        } else {
          const drainAgent = this.getOrCreateAgentSession(drainFresh, agentName);
          drainAgent.status = "failed";
        }
        await this.store.set(drainFresh.threadId, drainFresh);
      });
    } else {
      if (isTopLevel) {
        fresh.status = "idle";
      } else if (agentSession) {
        agentSession.status = result.error ? "failed" : "done";
        agentSession.lastActivity = Date.now();
      }
      await this.store.set(fresh.threadId, fresh);
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
        this.config.runner.provider,
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
    session.provider ??= "claude";
    return session;
  }

  private getOrCreateAgentSession(
    session: ThreadSession,
    agentName: string,
  ): AgentSession {
    session.agentSessions ??= {};
    session.agentSessions[agentName] ??= {
      agentName,
      provider: session.provider ?? this.config.runner.provider,
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
        provider: session.provider ?? this.config.runner.provider,
        activeAgentName: agentName,
        slackIdentity: agentIdentity,
        agentType: "lead",
      };
    }
    if (agentName === "default") {
      return {
        ...session,
        sessionId: session.leadSessionId ?? session.sessionId,
        provider: session.provider ?? this.config.runner.provider,
        activeAgentName: agentName,
        slackIdentity: agentIdentity,
      };
    }

    const agentSession = this.getOrCreateAgentSession(session, agentName);
    return {
      ...session,
      sessionId: agentSession.sessionId,
      provider: agentSession.provider ?? session.provider ?? this.config.runner.provider,
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
    const sections: string[] = [];
    if (systemPrompt) sections.push(systemPrompt);
    if (identity) {
      const isOrchestrator = agentName === "lead" || agentName === "default";
      const identityPrompt = [
        `You are the "${agentName}" agent in this Slack thread.`,
        `When posting through slack_send_message, pass username="${identity.username}" and icon_emoji="${identity.iconEmoji}".`,
        // Orchestrators (lead, default Junior) post as Junior's voice and
        // don't append a "by <agent>" suffix — that's a worker convention so
        // humans can tell workers' posts apart from the orchestrator's.
        isOrchestrator
          ? "Do not append an attribution suffix to your Slack messages."
          : `End every Slack message with "by ${agentName}".`,
      ].join("\n");
      sections.push(identityPrompt);
    }
    // Always inject the dispatch-allow block so the agent knows which
    // `!<agent>` directives it may emit.
    sections.push(buildDispatchAllowBlock(agentName));
    return sections.length > 0 ? sections.join("\n\n") : null;
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
