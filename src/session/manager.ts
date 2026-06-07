import type { App } from "@slack/bolt";
import type { Config } from "../config.ts";
import type { RunnerEvent, RunnerProvider, SpawnHandle, SpawnResult, SpawnRunnerFn } from "../runners/types.ts";
import type {
  SlackMessageEvent,
  SlackFileAttachment,
} from "../slack/events.ts";
import type { SessionStore } from "./store/interface.ts";
import type {
  AgentIdentity,
  AgentSession,
  DriverMode,
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
import { createDrivers, type DriverMap } from "../claude/factory.ts";
import { tmuxSessionNameFor } from "../claude/tmux-driver.ts";
import {
  buildDispatchAllowBlock,
  dispatchableAgentsFor,
  identityForAgent,
} from "../support/agents.ts";
import {
  parsePureAgentDirectiveResponse,
  type AgentDirective,
} from "../support/directives.ts";
import { validateLeadPipelineResponse } from "../support/pipeline-guard.ts";
import { withTimeout } from "../lifecycle/timeout.ts";
import {
  buildPromptPreamble,
  buildWorkspaceBlock,
  resolveSlackMentions,
  type WorkspaceContext,
} from "../slack/thread-context.ts";
import { isDuplicateSlackToolResponse } from "../slack/formatting.ts";
import { DEFAULT_CONTEXT_PROFILE, type AgentContextProfile } from "../agents/loader.ts";
import { downloadSlackFiles } from "../slack/files.ts";
import { log as _log } from "../logger.ts";
import type { MemoryIngestor } from "../memory/ingestion.ts";
import { clearThreadJuniorMessages } from "../slack/thread-archive.ts";

export class SessionManager {
  private store: SessionStore;
  private config: Config;
  private handles = new Map<string, SpawnHandle>();
  private seenMessages = new Set<string>();
  private spawnRunner: SpawnRunnerFn;
  private drivers: DriverMap;
  private memoryIngestor?: MemoryIngestor;

  slackApp?: App;
  botUserId?: string;
  selfBotId?: string;
  agentRouter?: AgentRouter;
  worktreeManager?: WorktreeManager;
  onResponse?: (session: ThreadSession, response: string) => void;
  onEvent?: (session: ThreadSession, event: RunnerEvent) => void;
  onMessageBuffered?: (event: SlackMessageEvent) => void;
  onError?: (session: ThreadSession, error: string | null) => void;
  onCommandResponse?: (event: SlackMessageEvent, response: string) => void;
  onReaction?: (event: SlackMessageEvent, emoji: string) => void;
  onClearThreadStatus?: (threadTs: string) => void;

  constructor(
    store: SessionStore,
    config: Config,
    spawnRunner?: SpawnRunnerFn,
    drivers?: DriverMap,
    memoryIngestor?: MemoryIngestor,
  ) {
    this.store = store;
    this.config = config;
    this.spawnRunner = spawnRunner ?? defaultSpawnRunner;
    this.drivers = drivers ?? createDrivers({
      spawnFn: (session, prompt, _claudeConfig, targetRepoCwd, botToken, agentIdentity) =>
        this.spawnRunner(
          { ...session, provider: "claude" },
          prompt,
          this.config,
          targetRepoCwd,
          botToken,
          agentIdentity,
        ),
    });
    this.memoryIngestor = memoryIngestor;
  }

  setMemoryIngestor(memoryIngestor: MemoryIngestor): void {
    this.memoryIngestor = memoryIngestor;
  }

  /** Public for tests + reconciliation; the manager doesn't expose drivers otherwise. */
  driverFor(mode: DriverMode | undefined): DriverMap[DriverMode] {
    return this.drivers[mode ?? "headless"];
  }

  /** Used by shutdown — let lifecycle code walk tmux sessions without re-importing the driver. */
  drivers_all(): DriverMap {
    return this.drivers;
  }

  async handleMessage(event: SlackMessageEvent): Promise<void> {
    await this.runSingleSession(event, "default");
  }

  /**
   * Attention gate. Runs before any routing and decides whether the message
   * should reach an agent at all. Returns `true` when the message is consumed
   * here (drop it; the caller must NOT route further) and `false` when normal
   * routing should continue.
   *
   * Handles:
   * - `!aside` — drop with 👀.
   * - `!listen` — clear dormant (if set) and drop with 👂.
   * - Wake on @mention — clear dormant and fall through to routing.
   * - Drop everything while muted, except `!unmute`.
   * - Drop everything while dormant.
   * - One-shot auto-dormant trigger when a second human posts without
   *   mentioning Junior. Announcement only fires once per thread (sticky
   *   `dormantAnnounced` flag), so manual `!listen` is respected — re-silence
   *   is `!aside` or `!mute`.
   *
   * Auto-trigger channels (any channel with a `channelDefaults` entry — e.g.
   * `#bugs-backlog`) are exempt: humans-talking-to-humans is the intended
   * input there, not a sidebar.
   */
  async gateAttention(event: SlackMessageEvent): Promise<boolean> {
    // !aside: drop the message but still record the sender as a participant —
    // they're a human in the room even if this message isn't for Junior. The
    // alternative (skip tracking) creates a corner where U-B posts only
    // asides, then a real non-mention message, and the gate fails to fire
    // because U-B was never registered as present.
    if (event.command === "aside") {
      const isHuman = !event.isSelfBot && !event.botId;
      if (isHuman && event.user) {
        const session = await this.store.get(event.threadId);
        if (session && !session.humanParticipants.includes(event.user)) {
          session.humanParticipants.push(event.user);
          await this.store.set(event.threadId, session);
        }
      }
      this.onReaction?.(event, "eyes");
      return true;
    }

    // Auto-trigger channels (e.g. #bugs-backlog) feed Junior every human
    // message by design — the gate would falsely dormant them.
    const isAutoTrigger = !!this.config.channelDefaults[event.channel];

    const session = await this.store.get(event.threadId);

    // Muted means no thread replies or runner dispatch until an admin sends
    // !unmute. Check this before auto-dormant so muted threads cannot still
    // emit the side-conversation notice.
    if (session?.muted && event.command !== "unmute") {
      return true;
    }

    // !listen: wake from dormant if needed. Anyone in the thread.
    if (event.command === "listen") {
      if (session && session.dormant) {
        session.dormant = false;
        session.needsThreadCatchup = true;
        await this.store.set(event.threadId, session);
      }
      this.onReaction?.(event, "ear");
      return true;
    }

    // @mention wakes a dormant thread, then falls through so the mention is
    // processed normally.
    if (event.mentionsJunior && session?.dormant) {
      session.dormant = false;
      session.needsThreadCatchup = true;
      await this.store.set(event.threadId, session);
    }

    // Dormant after the wake check → drop silently. No state change.
    if (session?.dormant) {
      return true;
    }

    if (isAutoTrigger) return false;

    // Trigger: actor must be human (not Junior, not its agents, not any
    // foreign bot). Session must exist with another human already recorded.
    // Message must not @mention Junior. And the gate fires at most once per
    // thread — once announced, dormancy is the human's call (`!aside` / `!mute`).
    const isHuman = !event.isSelfBot && !event.botId;
    if (
      isHuman &&
      session &&
      !session.dormantAnnounced &&
      !event.mentionsJunior
    ) {
      const otherHumans = session.humanParticipants.filter(
        (u) => u !== event.user,
      );
      if (otherHumans.length > 0) {
        session.dormant = true;
        session.dormantAnnounced = true;
        if (!session.humanParticipants.includes(event.user)) {
          session.humanParticipants.push(event.user);
        }
        await this.store.set(event.threadId, session);
        this.onCommandResponse?.(
          event,
          "Two people are interacting here, so I’ll stop replying. @ me or use !listen to bring me back.",
        );
        return true;
      }
    }

    return false;
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
    await this.captureSlackMemory(event, agentName, "persistent-agent");

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
    await this.captureSlackMemory(event, agentName, "single-session");

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
    session.activeAgentName = agentName;
    session.slackIdentity = identityForAgent(agentName);
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
      // Tear down any tmux state for this thread before deleting the row.
      // The row is the only place we track tmuxSessionName, so close drivers
      // first or we leak detached tmux sessions.
      if (session.driverMode === "tmux") {
        const tmux = this.driverFor("tmux");
        if (session.tmuxSessionName) {
          // topLevelTmuxAgent is "lead" in support channels and "default" elsewhere
          // — pick from the row, not a literal, or non-support channels leak.
          await tmux.close(threadId, session.topLevelTmuxAgent ?? "lead").catch(() => undefined);
        }
        for (const agentSession of Object.values(session.agentSessions ?? {})) {
          if (agentSession.tmuxSessionName) {
            await tmux.close(threadId, agentSession.agentName).catch(() => undefined);
          }
        }
      }
    }
    await this.store.delete(threadId);
  }

  /**
   * Shutdown path: interrupt live handles but keep the session rows and native
   * provider session ids. The next Slack turn can resume with --resume/--session
   * instead of starting from a blank conversation.
   */
  async terminateActiveRuns(reason = "shutdown"): Promise<void> {
    const handles = [...this.handles.entries()];
    const unsettledHandles = new Set(handles.map(([, handle]) => handle));
    for (const [key, handle] of handles) {
      this.handles.delete(key);
      handle.kill("SIGINT");
    }

    await Promise.race([
      Promise.allSettled(
        handles.map(([, handle]) =>
          handle.result.finally(() => {
            unsettledHandles.delete(handle);
          })
        ),
      ),
      new Promise((resolve) => setTimeout(resolve, 10_000)),
    ]);

    for (const handle of unsettledHandles) {
      handle.kill("SIGKILL");
    }

    const sessions = await this.store.getAll();
    for (const [threadId, session] of sessions) {
      let mutated = false;
      if (session.status === "busy" || session.status === "draining" || session.pid !== null) {
        session.status = "idle";
        session.pid = null;
        session.lastError = {
          type: reason,
          message: "Junior terminated an in-flight runner; send a new message to resume.",
          timestamp: Date.now(),
        };
        mutated = true;
      }
      for (const agentSession of Object.values(session.agentSessions ?? {})) {
        if (agentSession.status !== "busy" && agentSession.pid === null) continue;
        agentSession.status = "idle";
        agentSession.pid = null;
        mutated = true;
      }
      if (mutated) {
        await this.store.set(threadId, session);
      }
    }
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
      if (
        session.sessionId ||
        session.leadSessionId ||
        session.pendingMessages.length > 0 ||
        session.status !== "idle" ||
        session.tmuxSessionName
      ) {
        touched = true;
      }
      // handle.kill() above only sends Escape inside the tmux pane — the tmux
      // session itself survives. Without an explicit close the next turn
      // adopts a stale `--resume <sessionId>` pointing at a session we just
      // wiped, so the row and the live tmux session drift apart.
      if (session.driverMode === "tmux" && session.tmuxSessionName) {
        const tmux = this.driverFor("tmux");
        await tmux
          .close(threadId, session.topLevelTmuxAgent ?? agentName)
          .catch(() => undefined);
      }
      session.sessionId = null;
      session.leadSessionId = null;
      session.pendingMessages = [];
      session.status = "idle";
      session.pid = null;
      session.tmuxSessionName = null;
      session.topLevelTmuxAgent = null;
    } else if (session.agentSessions?.[agentName]) {
      const agentSession = session.agentSessions[agentName];
      if (session.driverMode === "tmux" && agentSession.tmuxSessionName) {
        const tmux = this.driverFor("tmux");
        await tmux.close(threadId, agentName).catch(() => undefined);
      }
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

      case "clear": {
        if (await this.denyIfNotAdmin(event)) return true;

        for (const key of this.handles.keys()) {
          if (key.startsWith(`${session.threadId}:`)) {
            this.onCommandResponse?.(
              event,
              "Cannot clear while a runner is active. Use `!cancel` or wait for the turn to finish.",
            );
            return true;
          }
        }

        if (!this.slackApp) {
          this.onCommandResponse?.(event, "Slack client not available.");
          return true;
        }

        try {
          const result = await clearThreadJuniorMessages({
            client: this.slackApp.client,
            channelId: event.channel,
            threadTs: session.threadId,
            selfBotId: this.selfBotId,
            botUserId: this.botUserId,
            archiveDir: this.config.threadArchives.dir,
            triggeredByUserId: event.user,
          });
          this.onClearThreadStatus?.(session.threadId);

          const archiveLabel = result.archivePath;
          if (result.deleteFailedCount > 0) {
            const failed = result.deleteFailedCount;
            const deleted = result.deletedCount;
            this.onCommandResponse?.(
              event,
              `Archived thread to \`${archiveLabel}\`, but failed to delete *${failed}* Junior message${failed === 1 ? "" : "s"}. Deleted *${deleted}* message${deleted === 1 ? "" : "s"}. Check logs for details.`,
            );
          } else if (result.deletedCount === 0) {
            this.onCommandResponse?.(
              event,
              `No Junior messages to clear. Archive saved to \`${archiveLabel}\` anyway.`,
            );
          } else {
            this.onCommandResponse?.(
              event,
              `Cleared *${result.deletedCount}* Junior message${result.deletedCount === 1 ? "" : "s"} from this thread.\nArchive: \`${archiveLabel}\``,
            );
          }
        } catch (err) {
          _log.error(
            "thread-archive",
            `clear.fail thread=${session.threadId} err=${err instanceof Error ? err.message : String(err)}`,
          );
          this.onCommandResponse?.(
            event,
            "Failed to clear thread messages. Check logs for details.",
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
          `*Dormant:* ${session.dormant ? "yes (auto)" : "no"}`,
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
          "`!provider <claude|opencode|opencode-sdk|codex-app-server>` — Set runner provider for this thread",
          "`!cancel` — Kill running process, keep session",
          "`!reset <agent|all>` — Reset one agent's state, or the whole thread (admin only)",
          "`!clear` — Archive thread to markdown and delete Junior messages (admin only)",
          "`!status` — Show session status",
          "`!quiet` — Minimal output",
          "`!normal` — Normal output",
          "`!verbose` — Verbose output",
          "`!adhoc <text>` — Add ad-hoc item to calendar",
          "`!bugs <text>` — Add bug item to calendar",
          "`!mute` — Stop responding until !unmute (admin only)",
          "`!unmute` — Resume responding (admin only)",
          "`!stop` — Interrupt in-flight turn; keep session alive (tmux: Escape; headless: kill)",
          "`!driver <headless|tmux>` — Switch this thread's Claude driver (admin only)",
          "`!aside [text]` — Drop just this message (side comment, humans only)",
          "`!listen` — Wake from auto-dormant mode",
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
            `Provider *${provider}* is planned but not yet implemented. Use \`!provider claude\`, \`!provider opencode\`, \`!provider opencode-sdk\`, or \`!provider codex-app-server\`.`,
          );
          return true;
        }
        if (!isImplementedRunnerProvider(provider)) {
          this.onCommandResponse?.(
            event,
            `Unknown provider "${provider}". Use \`!provider claude\`, \`!provider opencode\`, \`!provider opencode-sdk\`, or \`!provider codex-app-server\`.`,
          );
          return true;
        }

        const hasBusyAgent = Object.values(session.agentSessions ?? {}).some(
          (a) => a.status === "busy",
        );
        if (session.status !== "idle" || hasBusyAgent) {
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

      case "stop": {
        // Halt the in-flight turn WITHOUT killing the driver session.
        // Headless: kill the process (same as !cancel for one slot).
        // Tmux: send Escape to the TUI — the persistent claude stays alive,
        // input box clears, next message starts fresh.
        const driver = this.driverFor(session.driverMode);
        let touched = 0;
        for (const [key, handle] of this.handles) {
          if (!key.startsWith(`${session.threadId}:`)) continue;
          const agentName = key.slice(session.threadId.length + 1);
          await driver.interrupt(session.threadId, agentName).catch(() => undefined);
          handle.kill();
          this.handles.delete(key);
          touched++;
        }
        session.status = "idle";
        for (const agentSession of Object.values(session.agentSessions ?? {})) {
          if (agentSession.status === "busy") agentSession.status = "idle";
        }
        await this.store.set(session.threadId, session);
        this.onCommandResponse?.(
          event,
          touched === 0 ? "Nothing running." : `Interrupted (${touched} agent${touched === 1 ? "" : "s"}). Send a new message to continue.`,
        );
        return true;
      }

      case "driver": {
        if (await this.denyIfNotAdmin(event)) return true;
        const arg = event.text.trim().toLowerCase();
        if (arg !== "headless" && arg !== "tmux") {
          this.onCommandResponse?.(
            event,
            `Usage: \`!driver headless\` or \`!driver tmux\`. Current: *${session.driverMode}*.`,
          );
          return true;
        }
        if (session.driverMode === arg) {
          this.onCommandResponse?.(event, `Already on *${arg}*.`);
          return true;
        }
        // Tear down the outgoing driver's per-(thread,agent) state. Delete
        // the handle BEFORE close() so onRunComplete's `handles.get(key) !==
        // ownHandle` guard trips when close() resolves the activeTurn —
        // otherwise the resolved turn posts its partial text to Slack and
        // auto-drains buffered messages onto the new driver, contradicting
        // "Next message starts on the new path."
        const outgoing = this.driverFor(session.driverMode);
        for (const key of [...this.handles.keys()]) {
          if (!key.startsWith(`${session.threadId}:`)) continue;
          const agentName = key.slice(session.threadId.length + 1);
          this.handles.delete(key);
          await outgoing.close(session.threadId, agentName).catch(() => undefined);
        }
        // Between turns this.handles is empty — close the persisted tmux
        // session(s) explicitly or nulling tmuxSessionName below orphans them
        // (tmux-evict skips rows whose driverMode is no longer "tmux").
        if (session.driverMode === "tmux") {
          if (session.tmuxSessionName) {
            await outgoing
              .close(session.threadId, session.topLevelTmuxAgent ?? "lead")
              .catch(() => undefined);
          }
          for (const agentSession of Object.values(session.agentSessions ?? {})) {
            if (agentSession.tmuxSessionName) {
              await outgoing
                .close(session.threadId, agentSession.agentName)
                .catch(() => undefined);
              agentSession.tmuxSessionName = null;
            }
          }
        }
        session.driverMode = arg;
        if (arg !== "tmux") {
          session.tmuxSessionName = null;
          session.topLevelTmuxAgent = null;
        }
        // `handleCommand` runs before the busy gate in `runSingleSession`, so
        // !driver can fire mid-turn. The handle-delete-then-close loop above
        // intentionally bails out of `onRunComplete` via the guard, but that
        // guard skips the busy→idle flip too — so without this reset the row
        // wedges at "busy" and every subsequent message buffers without a
        // drain. !stop and !cancel both do the same flip for the same reason.
        if (session.status === "busy") session.status = "idle";
        for (const agentSession of Object.values(session.agentSessions ?? {})) {
          if (agentSession.status === "busy") agentSession.status = "idle";
        }
        await this.store.set(session.threadId, session);
        this.onCommandResponse?.(event, `Driver set to *${arg}*. Next message starts on the new path.`);
        return true;
      }

      // `aside` and `listen` are normally consumed in gateAttention before
      // routing reaches handleCommand. Defensive cases here keep them from
      // accidentally falling through to Claude as plain prompts if the gate
      // is bypassed (e.g. direct test invocations of handleMessage).
      case "aside": {
        this.onReaction?.(event, "eyes");
        return true;
      }

      case "listen": {
        if (session.dormant) {
          session.dormant = false;
          await this.store.set(session.threadId, session);
        }
        this.onReaction?.(event, "ear");
        return true;
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

      // Apply agent-declared model override to the session so the spawner
      // picks it up (session.model ?? config.defaultModel).
      // Only top-level agents (lead/default) persist the override to the
      // stored session; persistent workers carry it on runSession only so
      // the override is re-evaluated each turn from the agent definition.
      if (agentDefinition?.model) {
        runSession.model = agentDefinition.model;
        if (isTopLevel) {
          session.model = agentDefinition.model;
          await this.store.set(session.threadId, session);
        }
      }
      runSession.agentPermissions = agentDefinition?.permissions;

      // Build the prompt. On the first turn (no sessionId yet), inject the
      // preamble blocks the agent asked for. On resumed turns, --resume already
      // carries identity/context/history — keep just the workspace block (cheap
      // insurance for the worktree safety rule), and only if the agent wants
      // the workspace context at all.
      if (this.slackApp && latestTs) {
        const isFirstTurn = !runSession.sessionId;
        const needsThreadCatchup = !!session.needsThreadCatchup;
        const readablePrompt = await resolveSlackMentions(
          this.slackApp,
          prompt,
          this.botUserId,
        );
        if (isFirstTurn || needsThreadCatchup) {
          const preambleProfile: AgentContextProfile = needsThreadCatchup
            ? {
                ...contextProfile,
                identity: false,
                slack: true,
                threadHistory: true,
                threadHistoryLimit: Math.max(
                  contextProfile.threadHistoryLimit,
                  1000,
                ),
              }
            : contextProfile;
          const preamble = await buildPromptPreamble(
            this.slackApp,
            session.channel,
            session.threadId,
            latestTs,
            this.botUserId,
            workspace,
            worktreePaths,
            this.config.repos,
            preambleProfile,
          );
          prompt = preamble ? `${preamble}\n\n${readablePrompt}` : readablePrompt;
          if (needsThreadCatchup) {
            session.needsThreadCatchup = false;
            await this.store.set(session.threadId, session);
          }
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

      // Download files from Slack and append their paths to the prompt.
      let filePaths: string[] = [];
      let imagePaths: string[] = [];
      if (files && files.length > 0) {
        try {
          filePaths = await downloadSlackFiles(
            files,
            session.threadId,
            this.config.slack.botToken,
          );
          if (filePaths.length > 0) {
            const imageNames = new Set(
              files
                .filter((f) => f.mimetype.startsWith("image/"))
                .map((f) => f.name.split(/[\\/]/).pop() ?? f.name),
            );
            imagePaths = filePaths.filter((p) => {
              const name = p.split(/[\\/]/).pop() ?? p;
              return imageNames.has(name);
            });
            const pathList = filePaths.map((p) => `- ${p}`).join("\n");
            prompt += `\n\nThe user shared files. They are saved at these paths — read them from disk when needed:\n${pathList}`;
          }
        } catch (err) {
          console.error("[manager] Failed to download Slack files:", err);
        }
      }

      // Compose agent system prompt. The explicit default agent receives the
      // same selected-common prompt path as named worker agents.
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

      const provider = sessionProvider(runSession, this.config);
      let rawHandle: SpawnHandle;
      if (provider === "claude") {
        const driver = this.driverFor(session.driverMode);
        // For tmux, persist the deterministic session name BEFORE first send so
        // a crash mid-send leaves a recoverable trail. The driver computes the
        // same name; storing it here lets reconciliation find it later.
        if (session.driverMode === "tmux") {
          const tmuxName = tmuxSessionNameFor(session.threadId, agentName);
          if (isTopLevel) {
            session.tmuxSessionName = tmuxName;
            session.topLevelTmuxAgent = agentName;
          } else if (agentSession) {
            agentSession.tmuxSessionName = tmuxName;
          }
          await this.store.set(session.threadId, session);
        }
        rawHandle = driver.send({
          session: runSession,
          prompt,
          config: this.config.claude,
          targetRepoCwd,
          botToken: this.config.slack.botToken,
          agentIdentity,
          threadId: session.threadId,
          agentName,
        });
      } else {
        rawHandle = this.spawnRunner(
          runSession,
          prompt,
          this.config,
          targetRepoCwd,
          this.config.slack.botToken,
          agentIdentity,
          imagePaths,
        );
      }
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

      // Idle timer: if no runner event arrives for idleTimeoutMs, SIGINT then
      // resume with --session/--resume. Reset on every event. Escalate to
      // SIGKILL after 10s if the process doesn't exit cleanly.
      //
      // Only enabled for headless CLI providers (claude, opencode) where
      // Junior owns the process lifecycle. Server-attached providers
      // (opencode-sdk, codex-app-server) manage their own timeouts — a
      // sleeping server-attached session between turns should NOT be
      // SIGINT'd by Junior.
      const idleEnabled = this.idleResumeEnabled(provider);
      let idleInterrupted = false;
      let activeHandle = handle;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      let idleKillTimer: ReturnType<typeof setTimeout> | null = null;
      const clearIdleTimers = () => {
        if (idleTimer) clearTimeout(idleTimer);
        if (idleKillTimer) clearTimeout(idleKillTimer);
        idleTimer = null;
        idleKillTimer = null;
      };
      const armIdleTimer = () => {
        if (!idleEnabled) return;
        clearIdleTimers();
        idleTimer = setTimeout(() => {
          idleInterrupted = true;
          _log.warn("session", `idle-interrupt thread=${session.threadId} agent=${agentName} provider=${provider}`);
          activeHandle.kill("SIGINT");
          idleKillTimer = setTimeout(() => {
            _log.warn("session", `idle-escalate thread=${session.threadId} agent=${agentName} provider=${provider}`);
            activeHandle.kill("SIGKILL");
          }, 10_000);
        }, this.config.session.idleTimeoutMs);
      };
      armIdleTimer();

      handle.onEvent((event: RunnerEvent) => {
        armIdleTimer();
        if (event.type === "init") {
          if (isTopLevel) {
            session.sessionId = event.sessionId;
            session.leadSessionId = event.sessionId;
            session.provider = event.provider;
          } else if (agentSession) {
            agentSession.sessionId = event.sessionId;
            agentSession.provider = event.provider;
          }
          void this.persistRunSessionId(
            session.threadId,
            agentName,
            event.provider,
            event.sessionId,
          );
        }
        this.onEvent?.(this.buildRunSession(session, agentName, agentIdentity), event);
      });
      await this.persistRunProcessDetails(session.threadId, agentName, handle.pid);

      const maxIdleInterrupts = this.config.session.maxIdleInterrupts;
      let attemptHandle = handle;

      for (;;) {
        let result: SpawnResult;
        try {
          result = await attemptHandle.result;
        } catch (err: unknown) {
          result = {
            provider,
            sessionId: null,
            response: "",
            events: [],
            exitCode: null,
            error: err instanceof Error ? err.message : String(err),
          };
        } finally {
          clearIdleTimers();
        }

        if (
          idleInterrupted &&
          this.idleResumeEnabled(provider) &&
          (isTopLevel ? session.sessionId : agentSession?.sessionId) &&
          session.idleInterruptCount < maxIdleInterrupts
        ) {
          session.idleInterruptCount++;
          _log.warn(
            "session",
            `idle-resume attempt=${session.idleInterruptCount}/${maxIdleInterrupts} thread=${session.threadId} agent=${agentName} provider=${provider}`,
          );
          await this.store.set(session.threadId, session);

          const continuePrompt = [
            `The previous turn was interrupted after ${this.config.session.idleTimeoutMs / 1000}s with no runner events.`,
            `Idle interrupt ${session.idleInterruptCount} of ${maxIdleInterrupts}.`,
            "Continue from the last completed step.",
          ].join("\n");
          const retryRunSession = this.buildRunSession(session, agentName, agentIdentity);

          // Re-spawn with the continue prompt. Reuse the same rawHandle
          // creation path (driver.send for tmux, spawnRunner otherwise).
          let retryRawHandle: SpawnHandle;
          if (provider === "claude") {
            const driver = this.driverFor(session.driverMode);
            retryRawHandle = driver.send({
              session: retryRunSession,
              prompt: continuePrompt,
              config: this.config.claude,
              targetRepoCwd,
              botToken: this.config.slack.botToken,
              agentIdentity,
              threadId: session.threadId,
              agentName,
            });
          } else {
            retryRawHandle = this.spawnRunner(
              retryRunSession,
              continuePrompt,
              this.config,
              targetRepoCwd,
              this.config.slack.botToken,
              agentIdentity,
              [],
            );
          }
          const retryHandle = withTimeout(
            retryRawHandle,
            runnerTimeoutMs(this.config, provider),
            () => {
              console.warn(
                `[manager] ${provider} timed out (retry) for thread ${session.threadId}`,
              );
            },
          );
          this.handles.set(handleKey, retryHandle);
          if (isTopLevel) {
            session.pid = retryHandle.pid;
          } else if (agentSession) {
            agentSession.pid = retryHandle.pid;
          }

          activeHandle = retryHandle;
          idleInterrupted = false;
          retryHandle.onEvent((event: RunnerEvent) => {
            armIdleTimer();
            if (event.type === "init") {
              if (isTopLevel) {
                session.sessionId = event.sessionId;
                session.leadSessionId = event.sessionId;
                session.provider = event.provider;
              } else if (agentSession) {
                agentSession.sessionId = event.sessionId;
                agentSession.provider = event.provider;
              }
              void this.persistRunSessionId(
                session.threadId,
                agentName,
                event.provider,
                event.sessionId,
              );
            }
            this.onEvent?.(this.buildRunSession(session, agentName, agentIdentity), event);
          });
          await this.persistRunProcessDetails(session.threadId, agentName, retryHandle.pid);

          // Re-arm idle timer for the retry handle
          armIdleTimer();

          attemptHandle = retryHandle;
          continue;
        }

        // Normal completion (or idle-interrupted but out of retries).
        const exhaustedRetries = idleInterrupted && session.idleInterruptCount >= maxIdleInterrupts;
        // Reset idle interrupt count so the next turn starts fresh.
        session.idleInterruptCount = 0;
        if (result.error && exhaustedRetries) {
          result.error = `Idle interrupts exhausted after ${maxIdleInterrupts} attempts. ${result.error}`;
        }
        return this.onRunComplete(session, result, agentName, attemptHandle);
      }
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

  private async persistRunProcessDetails(
    threadId: string,
    agentName: string,
    pid: number | null,
  ): Promise<void> {
    const fresh = await this.store.get(threadId);
    if (!fresh) return;

    if (agentName === "lead" || agentName === "default") {
      if (fresh.status === "busy") {
        fresh.pid = pid;
      }
    } else {
      const agentSession = fresh.agentSessions?.[agentName];
      if (agentSession?.status === "busy") {
        agentSession.pid = pid;
      }
    }

    await this.store.set(threadId, fresh);
  }

  private async persistRunSessionId(
    threadId: string,
    agentName: string,
    provider: RunnerProvider,
    sessionId: string,
  ): Promise<void> {
    const fresh = await this.store.get(threadId);
    if (!fresh) return;

    if (agentName === "lead" || agentName === "default") {
      if (fresh.status === "busy" || fresh.status === "draining") {
        fresh.sessionId = sessionId;
        fresh.leadSessionId = sessionId;
        fresh.provider = provider;
      }
    } else {
      const agentSession = fresh.agentSessions?.[agentName];
      if (agentSession?.status === "busy") {
        agentSession.sessionId = sessionId;
        agentSession.provider = provider;
      }
    }

    await this.store.set(threadId, fresh);
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
    await this.captureRunnerMemory(fresh.threadId, agentName, result);
    const agentSession = isTopLevel
      ? null
      : this.getOrCreateAgentSession(fresh, agentName);
    let internalDispatchDirectives: AgentDirective[] = [];

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

    if (!result.error && isTopLevel && result.response) {
      const supportChannels = new Set(
        Object.entries(this.config.channelDefaults)
          .filter(([, def]) => def.agentType === "lead")
          .map(([channel]) => channel),
      );
      const validation = validateLeadPipelineResponse(
        this.buildRunSession(fresh, agentName, agentIdentity),
        result.response,
        supportChannels,
        fresh.pipelineGuardRetryCount ?? 0,
      );
      if (validation.action === "continue") {
        fresh.pipelineGuardRetryCount = (fresh.pipelineGuardRetryCount ?? 0) + 1;
        fresh.status = "busy";
        fresh.pid = null;
        await this.store.set(fresh.threadId, fresh);
        _log.warn(
          "pipeline",
          `guard.continue thread=${fresh.threadId} bug=${validation.state.bugId ?? "-"} reason=${validation.reason}`,
        );
        this.runRunnerWithAgent(
          fresh,
          validation.prompt,
          undefined,
          undefined,
          agentName,
        ).catch(async (err) => {
          _log.error(
            "pipeline",
            `guard.continue.fail thread=${fresh.threadId} err=${err instanceof Error ? err.message : String(err)}`,
          );
          const guardFresh = (await this.store.get(fresh.threadId)) ?? fresh;
          guardFresh.status = "idle";
          guardFresh.pid = null;
          await this.store.set(guardFresh.threadId, guardFresh);
        });
        return;
      }
      if (validation.action === "blocker") {
        _log.warn(
          "pipeline",
          `guard.blocker thread=${fresh.threadId} bug=${validation.state.bugId ?? "-"} reason=${validation.reason}`,
        );
        result = { ...result, response: validation.message };
        fresh.pipelineGuardRetryCount = 0;
      } else {
        fresh.pipelineGuardRetryCount = 0;
      }
    }

    if (result.response) {
      internalDispatchDirectives = this.allowedInternalDirectivesForResponse(
        agentName,
        result.response,
      );
      if (internalDispatchDirectives.length > 0) {
        _log.info(
          "dispatch",
          `thread=${fresh.threadId} agent=${agentName} internalized directives=${internalDispatchDirectives.map((d) => d.agentName).join(",")}`,
        );
      } else if (isDuplicateSlackToolResponse(result.response, result.events)) {
        _log.info(
          "response",
          `thread=${fresh.threadId} agent=${agentName} suppressed reason=duplicate-slack-tool-post`,
        );
      } else {
        this.onResponse?.(
          this.buildRunSession(fresh, agentName, agentIdentity),
          result.response,
        );
      }
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

    if (internalDispatchDirectives.length > 0) {
      await this.dispatchInternalAgentDirectives(
        fresh.threadId,
        agentName,
        internalDispatchDirectives,
      );
    }
  }

  private allowedInternalDirectivesForResponse(
    sourceAgentName: string,
    response: string,
  ): AgentDirective[] {
    const parsedDirectives = parsePureAgentDirectiveResponse(response);
    if (parsedDirectives.length === 0) return [];

    const allowedAgents = new Set(dispatchableAgentsFor(sourceAgentName));
    return parsedDirectives.every((directive) =>
      allowedAgents.has(directive.agentName)
    )
      ? parsedDirectives
      : [];
  }

  private async dispatchInternalAgentDirectives(
    threadId: string,
    sourceAgentName: string,
    directives: AgentDirective[],
  ): Promise<void> {
    const session = await this.store.get(threadId);
    if (!session) return;

    const sourceIdentity = identityForAgent(sourceAgentName);
    const now = Date.now();
    for (const [index, directive] of directives.entries()) {
      await this.handleAgentMessage(
        {
          threadId: session.threadId,
          channel: session.channel,
          user: this.botUserId ?? "junior-internal-dispatch",
          text: directive.prompt,
          ts: session.threadId,
          command: null,
          isSelfBot: true,
          botId: this.selfBotId,
          botUsername: sourceIdentity?.username,
          dedupeKey: `${session.threadId}:internal:${sourceAgentName}:${directive.agentName}:${index}:${now}`,
        },
        directive.agentName,
      );
    }
  }

  private async captureSlackMemory(
    event: SlackMessageEvent,
    agentName: string,
    route: string,
  ): Promise<void> {
    if (!this.memoryIngestor) return;
    try {
      await this.memoryIngestor.captureSlackMessage(event, { agentName, route });
      await this.memoryIngestor.captureRoutingDecision({
        threadId: event.threadId,
        channelId: event.channel,
        slackTs: event.ts,
        user: event.user,
        selectedAgent: agentName,
        reason: `Selected ${agentName} via ${route}${event.command ? ` for command ${event.command}` : ""}.`,
        text: event.text,
      });
    } catch (err) {
      _log.warn("memory", `capture.slack.fail thread=${event.threadId} err=${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async captureRunnerMemory(
    threadId: string,
    agentName: string,
    result: SpawnResult,
  ): Promise<void> {
    if (!this.memoryIngestor) return;
    try {
      await this.memoryIngestor.captureRunnerResult(threadId, agentName, result);
      await this.memoryIngestor.captureRunnerEvents(threadId, agentName, result.events);
    } catch (err) {
      _log.warn("memory", `capture.runner.fail thread=${threadId} agent=${agentName} err=${err instanceof Error ? err.message : String(err)}`);
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
        this.config.claude.defaultDriver,
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
    session.humanParticipants ??= [];
    session.needsThreadCatchup ??= false;

    // Track human participants for the attention gate. Bots — Junior, its
    // agents, and foreign bots — are excluded by design (see gateAttention).
    const isHuman = !event.isSelfBot && !event.botId;
    if (isHuman && event.user && !session.humanParticipants.includes(event.user)) {
      session.humanParticipants.push(event.user);
      await this.store.set(event.threadId, session);
    }

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

  /**
   * Idle interrupt (SIGINT + resume) should only fire for headless CLI
   * providers where Junior owns the process lifecycle. Server-attached
   * providers (opencode-sdk, codex-app-server) manage their own timeouts
   * and have sessions that are naturally "sleeping" between turns — Junior
   * should not interrupt them.
   */
  private idleResumeEnabled(provider: RunnerProvider): boolean {
    if (provider === "opencode") return this.config.opencode.continuityEnabled;
    return provider !== "opencode-sdk" && provider !== "codex-app-server";
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
      const iconInstruction = identity.iconEmoji
        ? `When posting through slack_send_message, pass username="${identity.username}" and icon_emoji="${identity.iconEmoji}".`
        : identity.imageUrl
          ? `When posting through slack_send_message, pass username="${identity.username}" and icon_url="${identity.imageUrl}".`
          : `When posting through slack_send_message, pass username="${identity.username}". Do NOT set icon_emoji or icon_url — the bot's default profile picture is correct for your role.`;
      const identityPrompt = [
        `You are the "${agentName}" agent in this Slack thread.`,
        iconInstruction,
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
