import type { App } from "@slack/bolt";
import type { Config, RepoConfig } from "../config.ts";
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
import { resolveAgentManifest } from "../agents/registry.ts";
import type { WorktreeManager } from "../worktree/manager.ts";
import type { PipelineStore } from "../pipelines/store/interface.ts";
import {
  createProductRun,
  shouldCreateProductRun,
} from "../pipelines/product/controller.ts";
import {
  createSession,
  isImplementedRunnerProvider,
  isRunnerProvider,
} from "./types.ts";
import { evaluateBusyFollowup } from "./followup-policy.ts";
import {
  runnerTimeoutMs,
  sessionProvider,
  spawnRunner as defaultSpawnRunner,
} from "../runners/index.ts";
import {
  isProviderSessionUnavailable,
  providerSessionMatchesCwd,
  resolveRunnerCwd,
  willResume,
} from "../runners/runtime.ts";
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
  escapeBlockDelimiters,
  resolveSlackMentions,
  resolveUserName,
  type WorkspaceContext,
} from "../slack/thread-context.ts";
import { isDuplicateSlackToolResponse } from "../slack/formatting.ts";
import { DEFAULT_CONTEXT_PROFILE, type AgentContextProfile } from "../agents/loader.ts";
import { downloadSlackFiles, sanitizeFileName } from "../slack/files.ts";
import { log as _log } from "../logger.ts";
import { inferReviewRepo } from "../worktree/review-routing.ts";
import {
  inferPipelinePrimaryRepo,
  resolvePipelineRepos,
} from "../worktree/pipeline-routing.ts";
import { detectJavaScriptPackageManager } from "../worktree/package-manager.ts";
import type { MemoryIngestor } from "../memory/ingestion.ts";
import { createPreRecall, type PreRecallFn } from "../memory/pre-recall.ts";
import { clearThreadJuniorMessages } from "../slack/thread-archive.ts";
import {
  formatPipelineStatusLines,
  projectRunSummary,
} from "../pipelines/projection.ts";
import { buildAssignmentContext } from "../pipelines/context.ts";
import { bugContextForAssignment } from "../pipelines/bug/controller.ts";
import { composeBugDispatchPrompt } from "../pipelines/bug/context.ts";
import { productContextForAssignment } from "../pipelines/product/controller.ts";
import { composeProductDispatchPrompt } from "../pipelines/product/context.ts";
import { createDefaultRun } from "../pipelines/default/controller.ts";
import { pumpOutbox } from "../pipelines/pump.ts";

export class SessionManager {
  private store: SessionStore;
  private config: Config;
  private handles = new Map<string, SpawnHandle>();
  private activeTurnSideEffects = new Map<string, boolean>();
  private seenMessages = new Set<string>();
  private worktreeSetups = new Map<string, Promise<string>>();
  private spawnRunner: SpawnRunnerFn;
  private drivers: DriverMap;
  private memoryIngestor?: MemoryIngestor;
  private preRecall: PreRecallFn | null;

  slackApp?: App;
  botUserId?: string;
  selfBotId?: string;
  agentRouter?: AgentRouter;
  worktreeManager?: WorktreeManager;
  /**
   * Optional pipeline store. When set and PRODUCT_PIPELINE_ENABLED +
   * PIPELINE_RUNTIME_MODE=active, explicit !pm / !build create ProductRuns.
   * Also used to enrich !status when a run is active.
   */
  pipelineStore?: PipelineStore;
  onResponse?: (session: ThreadSession, response: string) => unknown;
  onAgentSettled?: (
    session: ThreadSession,
    agentName: string,
    response: string | null,
  ) => void | Promise<void>;
  onAgentDispatched?: (
    session: ThreadSession,
    agentName: string,
  ) => void | Promise<void>;
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
    this.spawnRunner = spawnRunner ?? defaultSpawnRunnerForRuntime;
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
    this.preRecall = config.memory.preRecall?.enabled
      ? createPreRecall(config)
      : null;
  }

  setMemoryIngestor(memoryIngestor: MemoryIngestor): void {
    this.memoryIngestor = memoryIngestor;
  }

  /**
   * Enrich !status with the active durable run summary when a pipeline store
   * is wired. activePipelineRunId remains a typed-run compatibility alias.
   */
  private async pipelineStatusLines(
    session: ThreadSession,
  ): Promise<string[]> {
    const runId = session.activeRunId ?? session.activePipelineRunId;
    if (!runId || !this.pipelineStore) return [];
    try {
      const run = await this.pipelineStore.getRun(runId);
      if (!run) {
        return [`*Pipeline:* \`${runId}\` (run not found)`];
      }
      const assignments = await this.pipelineStore.listAssignments(run.id);
      let latestOutcome = null;
      // Prefer outcome from the most recently updated assignment.
      const sorted = [...assignments].sort(
        (a, b) => b.updatedAt - a.updatedAt,
      );
      for (const assignment of sorted) {
        const outcomes = await this.pipelineStore.listOutcomes(assignment.id);
        if (outcomes.length > 0) {
          latestOutcome = outcomes[outcomes.length - 1] ?? null;
          break;
        }
      }
      let attemptDigest: string | null = null;
      if (run.activeAttemptId) {
        const attempt = await this.pipelineStore.getAttempt(run.activeAttemptId);
        attemptDigest = attempt?.revisionDigest ?? null;
      }
      if (!attemptDigest) {
        attemptDigest =
          sorted.find((a) => a.candidateRevisionDigest)
            ?.candidateRevisionDigest ?? null;
      }
      const summary = projectRunSummary(run, assignments, latestOutcome, {
        attemptDigest,
      });
      return formatPipelineStatusLines(summary);
    } catch (err) {
      _log.warn(
        "status",
        `pipeline status enrichment failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [`*Pipeline:* \`${runId}\` (status unavailable)`];
    }
  }

  /**
   * Soft product-pipeline start on explicit !pm / !build when flags allow.
   * Sets session.activePipelineRunId; never blocks the legacy runner path.
   */
  private async tryCreateProductRun(
    session: ThreadSession,
    event: SlackMessageEvent,
  ): Promise<void> {
    const store = this.pipelineStore;
    if (!store) return;

    const startKind =
      event.command === "pm" ? "pm" : event.command === "build" ? "build" : null;
    if (!startKind) return;

    if (
      !shouldCreateProductRun({
        productPipelineEnabled:
          this.config.pipeline?.productPipelineEnabled === true,
        runtimeMode: this.config.pipeline?.runtimeMode ?? "off",
        explicitStart: true,
      })
    ) {
      return;
    }

    // Skip if thread already has a non-terminal pipeline run.
    if (session.activePipelineRunId) {
      const existing = await store.getRun(session.activePipelineRunId);
      if (existing && existing.status !== "terminal") return;
    }

    try {
      const result = await createProductRun(
        { store, workspaceRoot: process.cwd() },
        {
          channelId: event.channel,
          threadId: event.threadId,
          objective: event.text.trim() || `${startKind} request`,
          startKind,
          messageTs: event.ts,
          repoRefs: session.targetRepo ? [session.targetRepo] : [],
        },
      );

      if (result.created) {
        await this.store
          .mutateThread(event.threadId, (s) => {
            s.activePipelineRunId = result.run.id;
            s.activePipelineKind = "product";
            s.activeRunId = result.run.id;
          })
          .catch(async () => {
            const s = await this.store.get(event.threadId);
            if (s) {
              s.activePipelineRunId = result.run.id;
              s.activePipelineKind = "product";
              s.activeRunId = result.run.id;
              await this.store.set(event.threadId, s);
            }
          });
      }

      _log.info(
        "product-pipeline",
        `${result.created ? "created" : "reused"} ProductRun ${result.run.id.slice(0, 8)} phase=${result.run.phase} via !${startKind}`,
      );
    } catch (err) {
      _log.warn(
        "product-pipeline",
        `failed to create ProductRun (legacy path continues): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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
   *   mentioning Junior AND has never directly engaged it in this thread.
   *   Humans who have engaged Junior (@mention, a routed message, `!listen`)
   *   never trip the trigger — their follow-ups are conversation with Junior,
   *   not a sidebar. Announcement only fires once per thread (sticky
   *   `dormantAnnounced` flag), so manual `!listen` is respected — re-silence
   *   is `!aside` or `!mute`.
   *
   * Auto-trigger channels (any channel with a `channelDefaults` entry — e.g.
   * `#bugs-backlog`) are exempt: humans-talking-to-humans is the intended
   * input there, not a sidebar.
   */
  async gateAttention(event: SlackMessageEvent): Promise<boolean> {
    // Junior, its agents, and foreign bots never trip or feed the gate.
    const isHuman = !event.isSelfBot && !event.botId;

    // !aside: drop the message but still record the sender as a participant —
    // they're a human in the room even if this message isn't for Junior. The
    // alternative (skip tracking) creates a corner where U-B posts only
    // asides, then a real non-mention message, and the gate fails to fire
    // because U-B was never registered as present. Deliberately NOT marked
    // engaged — an aside is side-talk, not engagement.
    if (event.command === "aside") {
      if (isHuman && event.user) {
        const user = event.user;
        const session = await this.store.get(event.threadId);
        if (session && !session.humanParticipants.includes(user)) {
          await this.mutateSession(event.threadId, (s) => {
            if (!s.humanParticipants.includes(user)) {
              s.humanParticipants.push(user);
            }
          });
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

    // !listen: wake from dormant if needed. Anyone in the thread. An explicit
    // summon — the sender is engaging Junior, so mark them engaged too.
    if (event.command === "listen") {
      if (session) {
        const user = isHuman ? event.user : undefined;
        if (
          session.dormant ||
          (user && !session.engagedHumans.includes(user))
        ) {
          await this.mutateSession(event.threadId, (s) => {
            if (s.dormant) {
              s.dormant = false;
              s.needsThreadCatchup = true;
            }
            if (user && !s.engagedHumans.includes(user)) {
              s.engagedHumans.push(user);
            }
          });
        }
      }
      this.onReaction?.(event, "ear");
      return true;
    }

    // Dormant: an @mention wakes the thread and falls through so the mention
    // is processed normally; anything else drops silently.
    if (session?.dormant) {
      if (!event.mentionsJunior) return true;
      await this.mutateSession(event.threadId, (s) => {
        if (s.dormant) {
          s.dormant = false;
          s.needsThreadCatchup = true;
        }
      });
    }

    if (isAutoTrigger) return false;

    // Trigger: actor must be human (not Junior, not its agents, not any
    // foreign bot). Session must exist with another human already recorded.
    // Message must not @mention Junior, and the sender must never have
    // directly engaged Junior in this thread — someone already conversing
    // with Junior posting a plain follow-up is continuation, not a sidebar.
    // And the gate fires at most once per thread — once announced, dormancy
    // is the human's call (`!aside` / `!mute`).
    if (
      isHuman &&
      session &&
      !session.dormantAnnounced &&
      !event.mentionsJunior &&
      !(event.user && session.engagedHumans.includes(event.user))
    ) {
      const otherHumans = session.humanParticipants.filter(
        (u) => u !== event.user,
      );
      if (otherHumans.length > 0) {
        const user = event.user;
        await this.mutateSession(event.threadId, (s) => {
          s.dormant = true;
          s.dormantAnnounced = true;
          if (user && !s.humanParticipants.includes(user)) {
            s.humanParticipants.push(user);
          }
        });
        this.onCommandResponse?.(
          event,
          "Two people are interacting here, so I’ll stop replying. @ me or use !listen to bring me back.",
        );
        return true;
      }
    }

    // The message is about to route to Junior — the sender is directly
    // engaging it. Engaged humans never fire the sidebar trigger again
    // (the thread opener's first message has no session yet; that case is
    // covered by getOrCreateSession marking engagement on routed messages).
    if (
      isHuman &&
      event.user &&
      session &&
      !session.engagedHumans.includes(event.user)
    ) {
      const user = event.user;
      await this.mutateSession(event.threadId, (s) => {
        if (!s.engagedHumans.includes(user)) {
          s.engagedHumans.push(user);
        }
      });
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

    // Ensure the parent row exists before the concurrent-safe mutation.
    await this.getOrCreateSession(event);
    await this.captureSlackMemory(event, agentName, "persistent-agent");

    const directSession = await this.store.get(event.threadId);
    if (
      directSession &&
      await this.routeDirectTaskThroughDefaultRun(event, agentName, directSession)
    ) {
      this.rememberSeenMessage(dedupeKey);
      return;
    }

    // Object wrapper so TS doesn't narrow the flag past the mutator closure.
    const outcome: { action: "muted" | "buffer" | "run" } = { action: "run" };
    const session = await this.mutateSession(event.threadId, (s) => {
      if (s.muted) {
        outcome.action = "muted";
        return;
      }
      const agentSession = this.getOrCreateAgentSession(s, agentName);
      if (agentSession.status === "busy") {
        agentSession.pendingMessages.push(this.toPendingMessage(event));
        outcome.action = "buffer";
        return;
      }
      agentSession.status = "busy";
      agentSession.activePipelineInvocation = event.pipelineInvocation ?? null;
      agentSession.lastActivity = Date.now();
      s.lastActivity = agentSession.lastActivity;
      outcome.action = "run";
    });
    this.rememberSeenMessage(dedupeKey);

    if (outcome.action === "muted") return;

    if (outcome.action === "buffer") {
      this.onMessageBuffered?.(event);
      return;
    }

    const reservation = createRunSetupReservation(
      sessionProvider(this.buildRunSession(session, agentName), this.config),
    );
    this.handles.set(this.handleKey(session.threadId, agentName), reservation);
    await this.onAgentDispatched?.(session, agentName);
    this.runRunnerWithAgent(
      session,
      event.text,
      event.ts,
      event.files,
      agentName,
      event.user,
      reservation,
    );
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

    let session = await this.getOrCreateSession(event);
    await this.captureSlackMemory(event, agentName, "single-session");

    if (event.command) {
      const handled = await this.handleCommand(session, event);
      if (handled) {
        this.rememberSeenMessage(dedupeKey);
        return;
      }
      // Commands may have rewritten the row; re-read before the busy gate.
      session = (await this.store.get(event.threadId)) ?? session;
    }

    if (session.muted) {
      this.rememberSeenMessage(dedupeKey);
      return;
    }

    if (await this.routeDirectTaskThroughDefaultRun(event, agentName, session)) {
      this.rememberSeenMessage(dedupeKey);
      return;
    }

    await this.onAgentDispatched?.(session, agentName);

    const outcome: { action: "buffer" | "run" | "interrupt" } = { action: "run" };
    session = await this.mutateSession(event.threadId, (s) => {
      if (s.status === "busy") {
        const isHuman = !event.isSelfBot && !event.botId;
        const hk = this.handleKey(s.threadId, agentName);
        const decision = evaluateBusyFollowup({
          enabled: this.config.session.shortFollowupInterruptEnabled,
          senderUserId: event.user,
          activeTurnAuthor: s.activeTurnAuthor ?? null,
          messageLength: event.text.length,
          maxMessageLength: this.config.session.shortFollowupMaxLength,
          activeTurnHasSideEffects: this.activeTurnSideEffects.get(hk) === true,
          activeTurnAlreadyInterrupted: s.activeTurnWasInterrupted === true,
          isSenderHuman: isHuman,
        });

        if (decision.action === "interrupt") {
          _log.info(
            "session",
            `short-followup.interrupt thread=${s.threadId} agent=${agentName} reason=${decision.reason}`,
          );
          s.pendingMessages.push(this.toPendingMessage(event));
          s.activeTurnWasInterrupted = true;
          outcome.action = "interrupt";
        } else {
          // Shadow-mode logging: when feature is disabled but would have been eligible
          if (!this.config.session.shortFollowupInterruptEnabled) {
            const shadowDecision = evaluateBusyFollowup({
              enabled: true,
              senderUserId: event.user,
              activeTurnAuthor: s.activeTurnAuthor ?? null,
              messageLength: event.text.length,
              maxMessageLength: this.config.session.shortFollowupMaxLength,
              activeTurnHasSideEffects: this.activeTurnSideEffects.get(hk) === true,
              activeTurnAlreadyInterrupted: s.activeTurnWasInterrupted === true,
              isSenderHuman: isHuman,
            });
            if (shadowDecision.action === "interrupt") {
              _log.info(
                "session",
                `short-followup.shadow thread=${s.threadId} agent=${agentName} would-interrupt=true`,
              );
            }
          } else {
            _log.info(
              "session",
              `short-followup.buffer thread=${s.threadId} agent=${agentName} reason=${decision.reason}`,
            );
          }
          s.pendingMessages.push(this.toPendingMessage(event));
          outcome.action = "buffer";
        }
        return;
      }
      s.status = "busy";
      s.activePipelineInvocation = event.pipelineInvocation ?? null;
      s.activeAgentName = agentName;
      s.activeTopLevelMessageTs = event.ts;
      s.slackIdentity = identityForAgent(agentName);
      s.lastActivity = Date.now();
      s.activeTurnAuthor = event.user;
      s.activeTurnWasInterrupted = false;
      outcome.action = "run";
    });
    this.rememberSeenMessage(dedupeKey);

    if (outcome.action === "buffer") {
      this.onMessageBuffered?.(event);
      return;
    }

    if (outcome.action === "interrupt") {
      const handleKey = this.handleKey(session.threadId, agentName);
      const currentHandle = this.handles.get(handleKey);
      // Remove handle BEFORE kill so the old onRunComplete bails
      this.handles.delete(handleKey);
      if (currentHandle) currentHandle.kill();

      // Build consolidated prompt from all pending (includes the new followup).
      // Must happen before mutation clears pendingMessages.
      const drainPrompt = this.buildDrainPrompt(session.pendingMessages);

      session = await this.mutateSession(session.threadId, (s) => {
        s.pendingMessages = [];
        s.lastActivity = Date.now();
        s.activeTopLevelMessageTs = event.ts;
      });

      const reservation = createRunSetupReservation(
        sessionProvider(this.buildRunSession(session, agentName), this.config),
      );
      this.handles.set(handleKey, reservation);
      this.activeTurnSideEffects.set(handleKey, false);
      this.runRunnerWithAgent(
        session,
        drainPrompt,
        undefined,
        undefined,
        agentName,
        undefined,
        reservation,
      );
      return;
    }

    const handleKey = this.handleKey(session.threadId, agentName);
    const reservation = createRunSetupReservation(
      sessionProvider(this.buildRunSession(session, agentName), this.config),
    );
    this.handles.set(handleKey, reservation);
    this.activeTurnSideEffects.set(handleKey, false);
    this.runRunnerWithAgent(
      session,
      event.text,
      event.ts,
      event.files,
      agentName,
      event.user,
      reservation,
    );
  }

  async getSession(threadId: string): Promise<ThreadSession | undefined> {
    return this.store.get(threadId);
  }

  async updateSession(threadId: string, session: ThreadSession): Promise<void> {
    await this.store.set(threadId, session);
  }

  /**
   * Concurrent-safe session mutation. Prefer this over get→mutate→set for any
   * path that can race with parallel agent dispatch (fan-out, session-id
   * persist, pending-message append, settle).
   */
  async mutateSession(
    threadId: string,
    mutator: (
      session: ThreadSession,
    ) => void | ThreadSession | Promise<void | ThreadSession>,
  ): Promise<ThreadSession> {
    return this.store.mutateThread(threadId, mutator);
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
      await this.mutateSession(threadId, (s) => {
        s.sessionId = null;
        s.leadSessionId = null;
        s.sessionCwd = null;
        s.pendingMessages = [];
        s.activePipelineInvocation = null;
        s.status = "idle";
        s.pid = null;
        s.tmuxSessionName = null;
        s.topLevelTmuxAgent = null;
      });
    } else if (session.agentSessions?.[agentName]) {
      const agentSession = session.agentSessions[agentName];
      if (session.driverMode === "tmux" && agentSession.tmuxSessionName) {
        const tmux = this.driverFor("tmux");
        await tmux.close(threadId, agentName).catch(() => undefined);
      }
      // Atomic map + dual-write row delete (no resurrection window).
      await this.store.removeAgentSession(threadId, agentName);
      touched = true;
    }

    return touched;
  }

  async isAdmin(userId: string): Promise<boolean> {
    if (await this.isExplicitAdmin(userId)) return true;
    const envAdmin = this.config.adminSlackUserId;
    const extras = await this.store.extraAdmins();
    // Open-mode (local dev) only when NEITHER tier is configured. Without
    // this guard, an env-var misfire in prod that unsets ADMIN_SLACK_USER_ID
    // would silently promote everyone AND ignore the populated admins table.
    return !envAdmin && extras.size === 0;
  }

  /**
   * Like `isAdmin` but WITHOUT the open-mode fallback: true only when the user
   * is explicitly listed (env var or admins table). Sensitive gates — the
   * WhatsApp archive — use this so an unconfigured admin roster fails closed
   * instead of promoting every workspace user.
   */
  async isExplicitAdmin(userId: string): Promise<boolean> {
    const envAdmin = this.config.adminSlackUserId;
    if (envAdmin && userId === envAdmin) return true;
    const extras = await this.store.extraAdmins();
    return extras.has(userId);
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
        await this.mutateSession(session.threadId, (s) => {
          s.status = "idle";
          s.pid = null;
          s.pendingMessages = [];
          for (const agentSession of Object.values(s.agentSessions ?? {})) {
            agentSession.status = "idle";
            agentSession.pid = null;
            agentSession.pendingMessages = [];
          }
        });
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
        const pipelineLines = await this.pipelineStatusLines(session);
        if (pipelineLines.length > 0) {
          lines.push(...pipelineLines);
        }
        this.onCommandResponse?.(event, lines.join("\n"));
        return true;
      }

      case "help": {
        const helpText = [
          "*Commands:*",
          "`!build` — Build agent (continues to runner)",
          "`!frontend` — Frontend agent (continues to runner)",
          "`!review` — Review agent (continues to runner)",
          "`!pm` — Product manager agent (continues to runner)",
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
        await this.mutateSession(session.threadId, (s) => {
          s.verbosity = "quiet";
        });
        this.onCommandResponse?.(event, "Quiet mode.");
        return true;
      }

      case "verbose": {
        await this.mutateSession(session.threadId, (s) => {
          s.verbosity = "verbose";
        });
        this.onCommandResponse?.(event, "Verbose mode.");
        return true;
      }

      case "normal": {
        await this.mutateSession(session.threadId, (s) => {
          s.verbosity = "normal";
        });
        this.onCommandResponse?.(event, "Normal mode.");
        return true;
      }

      case "build":
      case "frontend":
      case "architect":
      case "pm": {
        const updated = await this.mutateSession(session.threadId, (s) => {
          s.agentType = event.command;
        });
        // Soft product-pipeline start: only !pm / !build when flags allow.
        if (event.command === "pm" || event.command === "build") {
          await this.tryCreateProductRun(updated, event);
        }
        return false;
      }

      case "repo": {
        const repoName = event.text.trim();
        const match = this.config.repos.find((r) => r.name === repoName);
        if (match) {
          await this.mutateSession(session.threadId, (s) => {
            s.targetRepo = match.name;
          });
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
        await this.mutateSession(session.threadId, (s) => {
          s.baseRef = ref;
        });
        this.onCommandResponse?.(event, `Base ref set to *${ref}*.`);
        return true;
      }

      case "agent": {
        const agentName = event.text.trim().toLowerCase();
        if (agentName === "junior" || agentName === "default") {
          await this.mutateSession(session.threadId, (s) => {
            s.defaultAgent = "junior";
          });
          this.onCommandResponse?.(event, "Thread default set to *Junior*. Future messages will go to Junior instead of the channel default.");
        } else if (agentName === "lead") {
          await this.mutateSession(session.threadId, (s) => {
            s.defaultAgent = "lead";
          });
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
        // (reproducer/review/lead/etc). Switching provider while ANY of
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

        await this.mutateSession(session.threadId, (s) => {
          s.provider = provider;
        });
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

        await this.mutateSession(session.threadId, (s) => {
          s.model = "haiku";
          s.cwd = "/tmp/junior-utility";
        });
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
        await this.mutateSession(session.threadId, (s) => {
          s.status = "idle";
          for (const agentSession of Object.values(s.agentSessions ?? {})) {
            if (agentSession.status === "busy") agentSession.status = "idle";
          }
        });
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
            }
          }
        }
        // Persist driver switch via CAS so concurrent agent settle cannot be
        // clobbered by a stale command snapshot.
        await this.mutateSession(session.threadId, (s) => {
          if (s.driverMode === "tmux") {
            for (const agentSession of Object.values(s.agentSessions ?? {})) {
              if (agentSession.tmuxSessionName) {
                agentSession.tmuxSessionName = null;
              }
            }
          }
          s.driverMode = arg;
          if (arg !== "tmux") {
            s.tmuxSessionName = null;
            s.topLevelTmuxAgent = null;
          }
          // `handleCommand` runs before the busy gate in `runSingleSession`, so
          // !driver can fire mid-turn. Reset busy so subsequent messages drain.
          if (s.status === "busy") s.status = "idle";
          for (const agentSession of Object.values(s.agentSessions ?? {})) {
            if (agentSession.status === "busy") agentSession.status = "idle";
          }
        });
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
          await this.mutateSession(session.threadId, (s) => {
            s.dormant = false;
          });
        }
        this.onReaction?.(event, "ear");
        return true;
      }

      case "mute": {
        if (await this.denyIfNotAdmin(event)) return true;
        await this.mutateSession(session.threadId, (s) => {
          s.muted = true;
        });
        this.onCommandResponse?.(event, "Muted. I'll stop responding until you `!unmute`.");
        return true;
      }

      case "unmute": {
        if (await this.denyIfNotAdmin(event)) return true;
        await this.mutateSession(session.threadId, (s) => {
          s.muted = false;
        });
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
    senderUserId?: string,
    expectedHandle?: SpawnHandle,
  ): Promise<void> {
    const isTopLevel = agentName === "lead" || agentName === "default";
    const reservationKey = this.handleKey(session.threadId, agentName);
    const assertRunOwnership = () => {
      if (expectedHandle && this.handles.get(reservationKey) !== expectedHandle) {
        throw new RunOwnershipChangedError();
      }
    };
    let runnerStarted = false;
    try {
      assertRunOwnership();
      let agentSession = isTopLevel
        ? null
        : this.getOrCreateAgentSession(session, agentName);
      const agentIdentity = identityForAgent(agentName);
      const rawMessage = prompt;

      const pipelineInvocation = isTopLevel
        ? session.activePipelineInvocation
        : agentSession?.activePipelineInvocation;
      const pipelineRunId =
        pipelineInvocation?.runId ?? session.activePipelineRunId ?? session.activeRunId;
      let activePipelineRun = pipelineRunId && this.pipelineStore
        ? await this.pipelineStore.getRun(pipelineRunId)
        : undefined;
      if (activePipelineRun?.status === "terminal") {
        activePipelineRun = undefined;
      }
      const activePipelineAssignment =
        pipelineInvocation && this.pipelineStore
          ? await this.pipelineStore.getAssignment(
              pipelineInvocation.assignmentId,
            )
          : undefined;
      assertRunOwnership();

      // An explicit PR URL is the strongest repo-affinity signal for review.
      // Outside a pipeline this preserves the existing review routing; inside
      // one it also selects which of the provisioned repo worktrees is primary.
      const inferredReviewRepo = agentName === "review"
        ? inferReviewRepo(
            this.config.repos,
            prompt,
            activePipelineRun?.repoRefs ?? [],
          )
        : undefined;

      if (activePipelineRun && pipelineInvocation) {
        // Durable repo refs, not a developer checkout or stale session cwd,
        // define the pipeline workspace. Provision every referenced repo so
        // fan-out agents can collaborate through the injected path map. Plain
        // human turns on a needs-human run do not own an assignment, so they
        // must remain usable to diagnose or reset an unrecoverable run.
        const resolution = resolvePipelineRepos(
          this.config.repos,
          activePipelineRun.repoRefs,
        );
        if (resolution.unresolvedRefs.length > 0) {
          throw new Error(
            `Pipeline ${activePipelineRun.id.slice(0, 8)} cannot run assignment ${pipelineInvocation.assignmentId.slice(0, 8)}: repository refs are not uniquely configured: ${resolution.unresolvedRefs.join(", ")}. Update the run repository refs/configuration or use !reset after preserving any work.`,
          );
        }

        const pipelineRepos = [...resolution.repos];
        const addRepo = (repo: RepoConfig | undefined) => {
          if (repo && !pipelineRepos.some((item) => item.name === repo.name)) {
            pipelineRepos.push(repo);
          }
        };
        addRepo(inferredReviewRepo);
        if (
          activePipelineRun.repoRefs.length === 0 &&
          pipelineRepos.length === 0
        ) {
          addRepo(
            session.targetRepo
              ? this.config.repos.find(
                  (repo) => repo.name === session.targetRepo,
                )
              : undefined,
          );
        }
        if (pipelineRepos.length === 0) {
          if (pipelineAgentRequiresWorktree(agentName)) {
            throw new Error(
              `Pipeline ${activePipelineRun.id.slice(0, 8)} cannot run ${agentName} assignment ${pipelineInvocation.assignmentId.slice(0, 8)} without a configured repository and isolated worktree. Add a repository to the run or use !reset after preserving any work.`,
            );
          }
          _log.info(
            "manager",
            `pipeline.workspace.skip thread=${session.threadId} run=${activePipelineRun.id} assignment=${pipelineInvocation.assignmentId} agent=${agentName} reason=repo-less-orchestration`,
          );
          session = await this.mutateSession(session.threadId, (fresh) => {
            assertRunOwnership();
            // A prior utility command may have pinned the thread to an
            // arbitrary cwd. Repo-less pipeline work belongs in Junior's
            // workspace, not that stale override.
            fresh.cwd = null;
          });
        } else {
          if (!this.worktreeManager) {
            throw new Error(
              `Pipeline ${activePipelineRun.id.slice(0, 8)} cannot run assignment ${pipelineInvocation.assignmentId.slice(0, 8)}: worktree manager is unavailable. Use !reset after preserving any work.`,
            );
          }

          const primaryRepo = inferPipelinePrimaryRepo({
            configuredRepos: this.config.repos,
            pipelineRepos,
            prompt,
            targetAgent: agentName,
            assignmentContextRefs: activePipelineAssignment?.contextRefs,
            onDiagnostic: (message) => {
              _log.warn(
                "manager",
                `pipeline.workspace.affinity thread=${session.threadId} run=${activePipelineRun.id} assignment=${pipelineInvocation.assignmentId} agent=${agentName} detail=${message}`,
              );
            },
          });
          if (!primaryRepo) {
            throw new Error(
              `Pipeline ${activePipelineRun.id.slice(0, 8)} cannot choose an isolated worktree. Use !reset after preserving any work.`,
            );
          }

          const provisioned = await Promise.all(
            pipelineRepos.map(async (repo) => [
              repo.name,
              await this.ensurePipelineWorktree(
                repo.name,
                session.threadId,
                session.baseRef ?? undefined,
              ),
            ] as const),
          );
          assertRunOwnership();
          const provisionedPaths = Object.fromEntries(provisioned);
          session = await this.mutateSession(session.threadId, (fresh) => {
            assertRunOwnership();
            fresh.worktreePaths = {
              ...fresh.worktreePaths,
              ...provisionedPaths,
            };
            fresh.targetRepo = primaryRepo.name;
            fresh.worktreePath = provisionedPaths[primaryRepo.name] ?? null;
            // Utility commands can leave an explicit cwd on the thread. Once a
            // durable pipeline owns the turn, persistently clear that override
            // so provider cold starts and recovery continuations also stay in
            // the managed worktree.
            fresh.cwd = null;
          });
        }
      } else if (inferredReviewRepo && this.worktreeManager) {
        if (session.targetRepo !== inferredReviewRepo.name) {
          session = await this.mutateSession(session.threadId, (fresh) => {
            assertRunOwnership();
            fresh.targetRepo = inferredReviewRepo.name;
            fresh.worktreePath =
              fresh.worktreePaths[inferredReviewRepo.name] ?? null;
          });
        }
      }

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
          const targetRepoName = targetRepo.name;
          session.worktreePath = await this.worktreeManager.createWorktree(
            targetRepoName,
            session.threadId,
            session.baseRef ?? undefined,
          );
          assertRunOwnership();
          const createdPath = session.worktreePath;
          session = await this.mutateSession(session.threadId, (fresh) => {
            assertRunOwnership();
            fresh.worktreePath = createdPath;
            fresh.worktreePaths = {
              ...fresh.worktreePaths,
              [targetRepoName]: createdPath,
            };
          });
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

      // cwd fallback: only used when no worktree exists. With the always-worktree
      // policy above, this only fires for read-only/discussion threads with no
      // targetRepo — never inside the shared origin repo.
      const targetRepoCwd: string | undefined = session.worktreePath
        ? undefined
        : targetRepo?.path;

      // Build after worktree routing/creation so provider policy and cwd see
      // the newly registered isolated checkout on this same turn.
      let runSession = this.buildRunSession(session, agentName, agentIdentity);
      let provider = sessionProvider(runSession, this.config);
      const invocationCwd = resolveRunnerCwd(runSession, targetRepoCwd);
      if (
        runSession.sessionId &&
        !providerSessionMatchesCwd({
          provider,
          sessionId: runSession.sessionId,
          sessionCwd: runSession.sessionCwd,
          cwd: invocationCwd,
        })
      ) {
        const staleSessionId = runSession.sessionId;
        const invalidation = await this.invalidateProviderSession(
          session.threadId,
          agentName,
          staleSessionId,
        );
        session = invalidation.session;
        agentSession = isTopLevel
          ? null
          : this.getOrCreateAgentSession(session, agentName);
        runSession = this.buildRunSession(session, agentName, agentIdentity);
        provider = sessionProvider(runSession, this.config);
        if (invalidation.invalidated) {
          _log.warn(
            "session",
            `provider-session.cold-start thread=${session.threadId} agent=${agentName} provider=${provider} reason=cwd-affinity`,
          );
          if (!latestTs) {
            prompt = await this.buildProviderColdStartPrompt(
              session,
              agentName,
              rawMessage,
            );
          }
        }
      }
      runSession.currentMessageTs = latestTs ?? null;
      await this.attachReviewVerificationPolicy(runSession, agentName);
      assertRunOwnership();

      // Resolve the agent definition early so its declared context profile
      // gates the preamble. Default agent (no .md) and missing-flag cases
      // fall back to DEFAULT_CONTEXT_PROFILE (all blocks on).
      const agentDefinition = this.agentRouter
        ? await this.agentRouter.resolveAgent(runSession)
        : null;
      assertRunOwnership();
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
          session = await this.mutateSession(session.threadId, (fresh) => {
            assertRunOwnership();
            fresh.model = agentDefinition.model ?? null;
          });
        }
      }
      // Per-agent Claude-runner model override (`model.claude` frontmatter).
      // Resolved by resolveClaudeModel at spawn; carried the same way as `model`.
      runSession.modelClaude = agentDefinition?.modelClaude ?? null;
      if (isTopLevel && agentDefinition?.modelClaude) {
        session = await this.mutateSession(session.threadId, (fresh) => {
          assertRunOwnership();
          fresh.modelClaude = agentDefinition.modelClaude ?? null;
        });
      }
      runSession.agentPermissions = agentDefinition?.permissions;

      // Build the prompt. When the provider will not resume a prior model
      // session, inject the preamble blocks the agent asked for. On resumed
      // turns, provider-native resume already carries identity/context/history —
      // keep just the workspace block (cheap insurance for the worktree safety
      // rule), and only if the agent wants the workspace context at all.
      // OpenCode may store a sessionId while continuity is disabled; treat that
      // as a fresh turn so thread/assignment/memory context is still injected.
      if (this.slackApp) {
        // Attribute the current message to its sender BEFORE mention resolution
        // so it renders as `User(Name <@ID>): text` — the same format thread
        // history uses. Without the label the model has no signal about who is
        // speaking and fills the gap from its persona/memory defaults.
        // Human-sent bodies also get block delimiters escaped so a message
        // can't smuggle in a forged <buffered-message from=...> block that
        // the instruction would treat as authoritative.
        let readablePrompt: string;
        if (this.isAttributableSender(senderUserId)) {
          const senderName = await resolveUserName(this.slackApp, senderUserId);
          const authorPrefix = `User(${senderName} <@${senderUserId}>)`;
          // Resolve inline mentions in the body with compact @Name format so
          // they are visually distinct from the authoritative author prefix.
          const bodyWithMentions = await resolveSlackMentions(
            this.slackApp,
            escapeBlockDelimiters(prompt),
            this.botUserId,
            { inline: true },
          );
          readablePrompt = `${authorPrefix}: ${bodyWithMentions}`;
        } else {
          readablePrompt = await resolveSlackMentions(
            this.slackApp,
            prompt,
            this.botUserId,
          );
        }
        if (!latestTs) {
          // Drain / internal continuation turns: no preamble decision to make,
          // but buffered messages still carry `<@ID>:` prefixes to resolve.
          prompt = readablePrompt;
        } else {
          const provider = sessionProvider(runSession, this.config);
          const resumes = willResume({
            provider,
            sessionId: runSession.sessionId,
            opencodeContinuityEnabled: this.config.opencode.continuityEnabled,
          }) && providerSessionMatchesCwd({
            provider,
            sessionId: runSession.sessionId,
            sessionCwd: runSession.sessionCwd,
            cwd: invocationCwd,
          });
          const isFirstTurn = !resumes;
          const needsThreadCatchup = !!session.needsThreadCatchup;
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
            assertRunOwnership();
            prompt = preamble ? `${preamble}\n\n${readablePrompt}` : readablePrompt;
            if (needsThreadCatchup) {
              session = await this.mutateSession(session.threadId, (fresh) => {
                assertRunOwnership();
                fresh.needsThreadCatchup = false;
              });
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
            // Match on the sanitized basename — that's what's on disk now.
            const imageNames = new Set(
              files
                .filter((f) => f.mimetype.startsWith("image/"))
                .map((f) => sanitizeFileName(f.name.split(/[\\/]/).pop() ?? f.name)),
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
        assertRunOwnership();
        if (isTopLevel) {
          session = await this.mutateSession(session.threadId, (fresh) => {
            assertRunOwnership();
            fresh.systemPrompt = runSession.systemPrompt;
          });
        } else {
          assertRunOwnership();
        }
      }

      if (contextProfile.agentState) {
        const agentStateBlock = this.buildAgentStateBlock(session);
        if (agentStateBlock) {
          prompt = `${agentStateBlock}\n\n${prompt}`;
        }
      }

      if (this.preRecall) {
        // Scope recall to the session's repo so another repo's conventions
        // can't inject into this session's prompt.
        const preRecallBlock = await this.preRecall(rawMessage, {
          repo: session.targetRepo,
        });
        assertRunOwnership();
        if (preRecallBlock) {
          prompt = `${preRecallBlock}\n\n${prompt}`;
        }
      }

      // We don't log the prompt to avoid spamming the logs. unless we are debugging it
      // log.info("prompt", `thread=${session.threadId} cwd=${targetRepoCwd ?? session.worktreePath ?? "junior"}\n--- PROMPT START ---\n${prompt}\n--- PROMPT END ---`);

      let rawHandle: SpawnHandle;
      if (provider === "claude") {
        const driver = this.driverFor(session.driverMode);
        // For tmux, persist the deterministic session name BEFORE first send so
        // a crash mid-send leaves a recoverable trail. The driver computes the
        // same name; storing it here lets reconciliation find it later.
        if (session.driverMode === "tmux") {
          const tmuxName = tmuxSessionNameFor(session.threadId, agentName);
          session = await this.mutateSession(session.threadId, (fresh) => {
            assertRunOwnership();
            if (isTopLevel) {
              fresh.tmuxSessionName = tmuxName;
              fresh.topLevelTmuxAgent = agentName;
            } else {
              this.getOrCreateAgentSession(fresh, agentName).tmuxSessionName = tmuxName;
            }
          });
        }
        assertRunOwnership();
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
        assertRunOwnership();
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
      runnerStarted = true;
      let attemptedResumeId = runSession.sessionId;
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
      assertRunOwnership();
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
        if (event.type === "tool") {
          this.activeTurnSideEffects.set(handleKey, true);
        }
        if (event.type === "init") {
          if (isTopLevel) {
            session.sessionId = event.sessionId;
            session.leadSessionId = event.sessionId;
            session.sessionCwd = invocationCwd;
            session.provider = event.provider;
          } else if (agentSession) {
            agentSession.sessionId = event.sessionId;
            agentSession.sessionCwd = invocationCwd;
            agentSession.provider = event.provider;
          }
          void this.persistRunSessionId(
            session.threadId,
            agentName,
            event.provider,
            event.sessionId,
            invocationCwd,
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

        // Claude can lose an otherwise persisted conversation (most commonly
        // after cwd/worktree routing changes). Repair that transport failure
        // once as a fresh provider session before pipeline settlement sees it;
        // this retry must not consume an assignment recovery continuation.
        if (
          attemptedResumeId &&
          isProviderSessionUnavailable(provider, result.error)
        ) {
          if (this.handles.get(handleKey) !== attemptHandle) return;
          let invalidation: { session: ThreadSession; invalidated: boolean };
          try {
            invalidation = await this.invalidateProviderSession(
              session.threadId,
              agentName,
              attemptedResumeId,
            );
          } catch (err) {
            if (err instanceof Error && err.message.startsWith("session not found:")) {
              return;
            }
            throw err;
          }
          // A reset or newer dispatch can take ownership while invalidation is
          // awaiting storage/tmux. Never spawn from the old result afterward.
          if (this.handles.get(handleKey) !== attemptHandle) return;
          if (!invalidation.invalidated) {
            // The persisted provider id moved forward independently. Settle
            // this old owning invocation without writing its stale id back.
            result = { ...result, sessionId: null };
          } else {
            _log.warn(
              "session",
              `provider-session.cold-start thread=${session.threadId} agent=${agentName} provider=${provider} reason=session-unavailable`,
            );
            const coldStartPrompt = await this.buildProviderColdStartPrompt(
              invalidation.session,
              agentName,
              rawMessage,
            );
            // Prompt reconstruction may await pipeline context. Re-check the
            // slot before launching so a concurrent reset cannot be replaced.
            if (this.handles.get(handleKey) !== attemptHandle) return;
            const restartSession = await this.store.get(session.threadId);
            if (!restartSession || this.handles.get(handleKey) !== attemptHandle) return;
            const restartOwner = this.buildRunSession(
              restartSession,
              agentName,
              agentIdentity,
            );
            if (restartOwner.sessionId) {
              result = { ...result, sessionId: null };
            } else {
              this.runRunnerWithAgent(
                restartSession,
                coldStartPrompt,
                latestTs ?? restartSession.activeTopLevelMessageTs ?? restartSession.threadId,
                files,
                agentName,
                senderUserId,
                attemptHandle,
              ).catch((err) => {
                _log.error(
                  "session",
                  `provider-session.cold-start.fail thread=${session.threadId} agent=${agentName} err=${err instanceof Error ? err.message : String(err)}`,
                );
              });
              return;
            }
          }
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
          await this.attachReviewVerificationPolicy(retryRunSession, agentName);
          attemptedResumeId = retryRunSession.sessionId;

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
            if (event.type === "tool") {
              this.activeTurnSideEffects.set(handleKey, true);
            }
            if (event.type === "init") {
              if (isTopLevel) {
                session.sessionId = event.sessionId;
                session.leadSessionId = event.sessionId;
                session.sessionCwd = invocationCwd;
                session.provider = event.provider;
              } else if (agentSession) {
                agentSession.sessionId = event.sessionId;
                agentSession.sessionCwd = invocationCwd;
                agentSession.provider = event.provider;
              }
              void this.persistRunSessionId(
                session.threadId,
                agentName,
                event.provider,
                event.sessionId,
                invocationCwd,
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

        const pipelineResolution = await this.resolvePipelineInvocation(
          session,
          agentName,
          result,
          attemptHandle,
          invocationCwd,
        );
        if (pipelineResolution === null) return;
        result = pipelineResolution;

        // Normal completion (or idle-interrupted but out of retries).
        const exhaustedRetries = idleInterrupted && session.idleInterruptCount >= maxIdleInterrupts;
        // Reset idle interrupt count so the next turn starts fresh.
        session.idleInterruptCount = 0;
        if (result.error && exhaustedRetries) {
          result.error = `Idle interrupts exhausted after ${maxIdleInterrupts} attempts. ${result.error}`;
        }
        return this.onRunComplete(
          session,
          result,
          agentName,
          attemptHandle,
          invocationCwd,
        );
      }
    } catch (err) {
      if (err instanceof RunOwnershipChangedError) return;
      if (expectedHandle && this.handles.get(reservationKey) !== expectedHandle) {
        return;
      }
      let fatalMessage = err instanceof Error ? err.message : String(err);
      if (!runnerStarted && expectedHandle && this.pipelineStore) {
        try {
          const setupResult = await this.resolvePipelineInvocation(
            session,
            agentName,
            {
              provider: sessionProvider(
                this.buildRunSession(
                  session,
                  agentName,
                  identityForAgent(agentName),
                ),
                this.config,
              ),
              sessionId: null,
              response: "",
              events: [],
              exitCode: null,
              error: fatalMessage,
              completion: {
                status: "failure",
                reason: "provider_error",
                retryable: false,
              },
            },
            expectedHandle,
            session.worktreePath ?? process.cwd(),
          );
          if (!setupResult) return;
          fatalMessage = setupResult.error ?? fatalMessage;
        } catch (settlementErr) {
          const settlementMessage = settlementErr instanceof Error
            ? settlementErr.message
            : String(settlementErr);
          _log.error(
            "pipeline",
            `setup.settlement.fail thread=${session.threadId} agent=${agentName} err=${settlementMessage}`,
          );
          fatalMessage = `${fatalMessage} Pipeline settlement also failed: ${settlementMessage}`;
        }
      }
      if (expectedHandle) this.handles.delete(reservationKey);
      // Agent prompt composition or worktree creation failed fatally
      try {
        session = await this.mutateSession(session.threadId, (fresh) => {
          if (isTopLevel) {
            fresh.status = "idle";
          } else {
            const failedAgent = this.getOrCreateAgentSession(fresh, agentName);
            failedAgent.status = "failed";
            failedAgent.pid = null;
          }
          fresh.lastError = {
            type: "setup",
            message: fatalMessage,
            timestamp: Date.now(),
          };
        });
      } catch (persistErr) {
        if (
          persistErr instanceof Error &&
          persistErr.message.startsWith("session not found:")
        ) return;
        throw persistErr;
      }
      this.onError?.(
        this.buildRunSession(session, agentName, identityForAgent(agentName)),
        session.lastError?.message ?? "runner setup failed",
      );
    }
  }

  /**
   * A pipeline invocation is complete only after its exact assignment gains a
   * new durable outcome. Claude/process completion is merely a transport
   * signal. Missing outcomes resume quietly; exhaustion records one durable
   * escalation and lets the normal error path post one concise failure.
   */
  private async resolvePipelineInvocation(
    session: ThreadSession,
    agentName: string,
    result: SpawnResult,
    ownHandle: SpawnHandle,
    invocationCwd: string,
  ): Promise<SpawnResult | null> {
    if (!this.pipelineStore) return result;
    const handleKey = this.handleKey(session.threadId, agentName);
    if (this.handles.get(handleKey) !== ownHandle) return null;
    const fresh = await this.store.get(session.threadId);
    if (!fresh) return null;
    const isTopLevel = agentName === "lead" || agentName === "default";
    const invocation = isTopLevel
      ? fresh.activePipelineInvocation
      : fresh.agentSessions?.[agentName]?.activePipelineInvocation;
    if (!invocation) return result;

    const [run, assignment, outcomes] = await Promise.all([
      this.pipelineStore.getRun(invocation.runId),
      this.pipelineStore.getAssignment(invocation.assignmentId),
      this.pipelineStore.listOutcomes(invocation.assignmentId),
    ]);
    if (!run || !assignment) {
      return {
        ...result,
        response: "",
        error: `Pipeline settlement state is missing for run ${invocation.runId.slice(0, 8)} / assignment ${invocation.assignmentId.slice(0, 8)}.`,
        completion: {
          status: "failure",
          reason: "provider_error",
          retryable: false,
        },
      };
    }
    const durable =
      run.status === "terminal" ||
      !["pending", "leased"].includes(assignment.status) ||
      outcomes.length > invocation.outcomeCountAtDispatch;

    if (durable) {
      // The typed outcome is authoritative. A provider may hit its turn cap
      // immediately after committing it; that must not become a Slack error.
      return result.error
        ? {
            ...result,
            response: "",
            error: null,
            completion: {
              status: "success",
              reason: "completed",
              retryable: false,
              providerSubtype: result.completion?.providerSubtype,
              turns: result.completion?.turns,
            },
          }
        : result;
    }

    const sessionId = isTopLevel
      ? fresh.sessionId
      : fresh.agentSessions?.[agentName]?.sessionId;
    const maxRetries = 2;
    const canContinueProviderSession =
      !result.error || result.completion?.retryable === true;
    if (
      invocation.retryCount < maxRetries &&
      (result.sessionId || sessionId) &&
      canContinueProviderSession
    ) {
      if (this.handles.get(handleKey) !== ownHandle) return null;
      const retryCount = invocation.retryCount + 1;
      let continued: ThreadSession;
      try {
        continued = await this.mutateSession(fresh.threadId, (current) => {
          const owner = isTopLevel
            ? current
            : this.getOrCreateAgentSession(current, agentName);
          const active = owner.activePipelineInvocation;
          if (!active || active.dispatchKey !== invocation.dispatchKey) {
            throw new Error("pipeline invocation ownership changed");
          }
          owner.activePipelineInvocation = { ...active, retryCount };
          if (result.sessionId) {
            owner.sessionId = result.sessionId;
            owner.sessionCwd = invocationCwd;
            owner.provider = result.provider;
            if (isTopLevel) current.leadSessionId = result.sessionId;
          }
          owner.status = "busy";
          owner.pid = null;
        });
      } catch (err) {
        if (
          err instanceof Error &&
          (err.message === "pipeline invocation ownership changed" ||
            err.message.startsWith("session not found:"))
        ) {
          return null;
        }
        throw err;
      }
      if (this.handles.get(handleKey) !== ownHandle) return null;
      const continuation = [
        "The pipeline assignment has not recorded a typed outcome yet.",
        `Recovery continuation ${retryCount} of ${maxRetries}. Resume this same session from durable state; do not repeat completed mutations.`,
        "Finish any remaining work, then call pipeline_report_outcome for the active assignment before ending this invocation.",
      ].join("\n");
      _log.warn(
        "pipeline",
        `settlement.resume thread=${fresh.threadId} agent=${agentName} assignment=${invocation.assignmentId} attempt=${retryCount}/${maxRetries} reason=${result.completion?.reason ?? (result.error ? "runner-error" : "missing-outcome")}`,
      );
      this.runRunnerWithAgent(
        continued,
        continuation,
        undefined,
        undefined,
        agentName,
        undefined,
        ownHandle,
      ).catch((err) => {
        _log.error(
          "pipeline",
          `settlement.resume.fail thread=${fresh.threadId} assignment=${invocation.assignmentId} err=${err instanceof Error ? err.message : String(err)}`,
        );
      });
      return null;
    }

    const recoverySummary = invocation.retryCount === 0
      ? "without a recovery continuation"
      : `after ${invocation.retryCount} recovery continuation${invocation.retryCount === 1 ? "" : "s"}`;
    let escalationPersisted = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.handles.get(handleKey) !== ownHandle) return null;
      const [latestRun, latestAssignment, latestOutcomes] = await Promise.all([
        this.pipelineStore.getRun(invocation.runId),
        this.pipelineStore.getAssignment(invocation.assignmentId),
        this.pipelineStore.listOutcomes(invocation.assignmentId),
      ]);
      if (
        !latestRun ||
        !latestAssignment ||
        latestRun.status === "terminal" ||
        !["pending", "leased"].includes(latestAssignment.status) ||
        latestOutcomes.length > invocation.outcomeCountAtDispatch
      ) {
        // Another actor durably settled or advanced this assignment while the
        // exhausted invocation was finishing. Trust that durable state.
        return result.error
          ? {
              ...result,
              response: "",
              error: null,
              completion: {
                status: "success",
                reason: "completed",
                retryable: false,
                providerSubtype: result.completion?.providerSubtype,
                turns: result.completion?.turns,
              },
            }
          : result;
      }
      const receipt = await this.pipelineStore.recordOutcomeTransaction({
        outcome: {
          assignmentId: invocation.assignmentId,
          expectedRunVersion: latestRun.stateVersion,
          action: "escalate",
          status: "blocked",
          reason: `Pipeline invocation ended without a typed outcome ${recoverySummary}.`,
          evidenceRefs: [],
          artifactRefs: [],
          blockers: [{
            kind: "infra_failure",
            detail: result.error ?? "runner completed without reporting an outcome",
          }],
          checks: [],
          progressFingerprint: `settlement-exhausted:${invocation.dispatchKey}`,
        },
        toPhase: "needs-human",
        actorType: "system",
        actorId: "pipeline-settlement",
        idempotencyKey: `pipeline-settlement-exhausted:${invocation.dispatchKey}`,
      });
      if (
        receipt.status === "accepted" ||
        receipt.status === "escalated" ||
        receipt.status === "duplicate"
      ) {
        escalationPersisted = true;
        break;
      }
      if (!/state version conflict/i.test(receipt.reason ?? "")) break;
    }
    if (!escalationPersisted) {
      if (this.handles.get(handleKey) !== ownHandle) return null;
      this.handles.delete(handleKey);
      const persistenceError =
        `Pipeline assignment ${invocation.assignmentId.slice(0, 8)} exhausted recovery, but its escalation could not be persisted. The assignment remains active for retry.`;
      let preserved: ThreadSession;
      try {
        preserved = await this.mutateSession(fresh.threadId, (current) => {
          const owner = isTopLevel
            ? current
            : this.getOrCreateAgentSession(current, agentName);
          const active = owner.activePipelineInvocation;
          if (!active || active.dispatchKey !== invocation.dispatchKey) return;
          owner.status = isTopLevel ? "idle" : "failed";
          owner.pid = null;
          current.lastError = {
            type: "pipeline-settlement",
            message: persistenceError,
            timestamp: Date.now(),
          };
        });
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("session not found:")) {
          return null;
        }
        throw err;
      }
      this.onError?.(
        this.buildRunSession(preserved, agentName, identityForAgent(agentName)),
        persistenceError,
      );
      return null;
    }
    return {
      ...result,
      response: "",
      error: formatPipelineSettlementError(
        invocation.assignmentId,
        recoverySummary,
        result.error,
      ),
      completion: {
        status: "failure",
        reason: result.completion?.reason ?? "provider_error",
        retryable: false,
        providerSubtype: result.completion?.providerSubtype,
        turns: result.completion?.turns,
      },
    };
  }

  private async persistRunProcessDetails(
    threadId: string,
    agentName: string,
    pid: number | null,
  ): Promise<void> {
    try {
      await this.mutateSession(threadId, (fresh) => {
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
      });
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("session not found:")) {
        return;
      }
      throw err;
    }
  }

  private async persistRunSessionId(
    threadId: string,
    agentName: string,
    provider: RunnerProvider,
    sessionId: string,
    sessionCwd: string,
  ): Promise<void> {
    try {
      await this.mutateSession(threadId, (fresh) => {
        if (agentName === "lead" || agentName === "default") {
          if (fresh.status === "busy" || fresh.status === "draining") {
            fresh.sessionId = sessionId;
            fresh.leadSessionId = sessionId;
            fresh.sessionCwd = sessionCwd;
            fresh.provider = provider;
          }
        } else {
          const agentSession = fresh.agentSessions?.[agentName];
          if (agentSession?.status === "busy") {
            agentSession.sessionId = sessionId;
            agentSession.sessionCwd = sessionCwd;
            agentSession.provider = provider;
          }
        }
      });
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("session not found:")) {
        return;
      }
      throw err;
    }
  }

  private async invalidateProviderSession(
    threadId: string,
    agentName: string,
    expectedSessionId: string,
  ): Promise<{ session: ThreadSession; invalidated: boolean }> {
    const before = await this.store.get(threadId);
    let invalidated = false;
    const session = await this.mutateSession(threadId, (fresh) => {
      // mutateThread may re-run this callback after a CAS conflict.
      invalidated = false;
      if (agentName === "lead" || agentName === "default") {
        const currentSessionId = fresh.leadSessionId ?? fresh.sessionId;
        if (currentSessionId !== expectedSessionId) return;
        invalidated = true;
        fresh.sessionId = null;
        fresh.leadSessionId = null;
        fresh.sessionCwd = null;
        fresh.tmuxSessionName = null;
        fresh.topLevelTmuxAgent = null;
        return;
      }

      const agentSession = fresh.agentSessions?.[agentName];
      if (!agentSession || agentSession.sessionId !== expectedSessionId) return;
      invalidated = true;
      agentSession.sessionId = null;
      agentSession.sessionCwd = null;
      agentSession.tmuxSessionName = null;
    });
    if (invalidated && before?.driverMode === "tmux") {
      await this.driverFor("tmux")
        .closeIfSessionId(threadId, agentName, expectedSessionId)
        .catch(() => false);
    }
    return { session, invalidated };
  }

  private async buildProviderColdStartPrompt(
    session: ThreadSession,
    agentName: string,
    fallbackPrompt: string,
  ): Promise<string> {
    if (!this.pipelineStore) return fallbackPrompt;
    const invocation = agentName === "lead" || agentName === "default"
      ? session.activePipelineInvocation
      : session.agentSessions?.[agentName]?.activePipelineInvocation;
    if (!invocation) return fallbackPrompt;

    const [run, assignment] = await Promise.all([
      this.pipelineStore.getRun(invocation.runId),
      this.pipelineStore.getAssignment(invocation.assignmentId),
    ]);
    if (!run || !assignment) return fallbackPrompt;

    const assignmentContext = buildAssignmentContext({ run, assignment });
    const objective = [
      assignment.objective,
      "[provider-session-recovery]",
      fallbackPrompt,
    ].join("\n\n");
    try {
      if (run.kind === "bug") {
        const bugContext = await bugContextForAssignment(
          { store: this.pipelineStore, workspaceRoot: process.cwd() },
          run,
          assignment,
        );
        return composeBugDispatchPrompt({
          bugContext,
          assignmentContext,
          objective,
        });
      }
      if (run.kind === "default") {
        return `${assignmentContext}\n\n${objective}`;
      }
      const productContext = await productContextForAssignment(
        { store: this.pipelineStore, workspaceRoot: process.cwd() },
        run,
        assignment,
      );
      return composeProductDispatchPrompt({
        productContext,
        assignmentContext,
        objective,
      });
    } catch (err) {
      _log.warn(
        "session",
        `provider-session.context-rebuild.fail thread=${session.threadId} agent=${agentName} run=${run.id} assignment=${assignment.id} err=${err instanceof Error ? err.message : String(err)}`,
      );
      return `${assignmentContext}\n\n${objective}`;
    }
  }

  private async onRunComplete(
    session: ThreadSession,
    result: SpawnResult,
    agentName: string,
    ownHandle?: SpawnHandle,
    invocationCwd?: string,
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
    const stillOwnsRun = () =>
      !ownHandle || this.handles.get(handleKey) === ownHandle;

    // Snapshot for read-only side effects (validation, onResponse). All
    // durable mutations go through mutateSession so parallel agents cannot
    // clobber each other via a stale full-row write.
    const snapshot = await this.store.get(session.threadId);
    if (!snapshot || !stillOwnsRun()) return;
    await this.captureRunnerMemory(snapshot.threadId, agentName, result);
    if (!stillOwnsRun()) return;
    let internalDispatchDirectives: AgentDirective[] = [];
    let pipelineGuardRetryReset = false;

    if (result.error) {
      this.onError?.(
        this.buildRunSession(snapshot, agentName, agentIdentity),
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
        this.buildRunSession(snapshot, agentName, agentIdentity),
        result.response,
        supportChannels,
        snapshot.pipelineGuardRetryCount ?? 0,
      );
      if (validation.action === "continue") {
        if (!stillOwnsRun()) return;
        let continued: ThreadSession;
        try {
          continued = await this.mutateSession(snapshot.threadId, (s) => {
            if (!stillOwnsRun()) throw new RunOwnershipChangedError();
            if (result.sessionId) {
              s.sessionId = result.sessionId;
              s.leadSessionId = result.sessionId;
              s.sessionCwd = invocationCwd ?? s.sessionCwd ?? null;
              s.provider = result.provider;
            }
            s.pipelineGuardRetryCount = (s.pipelineGuardRetryCount ?? 0) + 1;
            s.status = "busy";
            s.pid = null;
          });
        } catch (err) {
          if (
            err instanceof RunOwnershipChangedError ||
            (err instanceof Error && err.message.startsWith("session not found:"))
          ) {
            return;
          }
          throw err;
        }
        _log.warn(
          "pipeline",
          `guard.continue thread=${continued.threadId} bug=${validation.state.bugId ?? "-"} reason=${validation.reason}`,
        );
        this.runRunnerWithAgent(
          continued,
          validation.prompt,
          undefined,
          undefined,
          agentName,
          undefined,
          ownHandle,
        ).catch(async (err) => {
          _log.error(
            "pipeline",
            `guard.continue.fail thread=${continued.threadId} err=${err instanceof Error ? err.message : String(err)}`,
          );
          try {
            await this.mutateSession(continued.threadId, (s) => {
              s.status = "idle";
              s.pid = null;
            });
          } catch {
            // Session may have been reset mid-guard.
          }
        });
        return;
      }
      if (validation.action === "blocker") {
        _log.warn(
          "pipeline",
          `guard.blocker thread=${snapshot.threadId} bug=${validation.state.bugId ?? "-"} reason=${validation.reason}`,
        );
        result = { ...result, response: validation.message };
      }
      pipelineGuardRetryReset = true;
    }

    if (result.response) {
      internalDispatchDirectives = this.allowedInternalDirectivesForResponse(
        agentName,
        result.response,
      );
      if (internalDispatchDirectives.length > 0) {
        _log.info(
          "dispatch",
          `thread=${snapshot.threadId} agent=${agentName} internalized directives=${internalDispatchDirectives.map((d) => d.agentName).join(",")}`,
        );
      } else if (isDuplicateSlackToolResponse(result.response, result.events)) {
        _log.info(
          "response",
          `thread=${snapshot.threadId} agent=${agentName} suppressed reason=duplicate-slack-tool-post`,
        );
      } else {
        await this.onResponse?.(
          this.buildRunSession(snapshot, agentName, agentIdentity),
          result.response,
        );
        if (!stillOwnsRun()) return;
      }
    }

    type SettleAction = "muted-discard" | "drain" | "settle";
    const settle: { action: SettleAction; drainPrompt: string } = {
      action: "settle",
      drainPrompt: "",
    };

    let settled: ThreadSession;
    try {
      if (!stillOwnsRun()) return;
      settled = await this.mutateSession(snapshot.threadId, (s) => {
        if (!stillOwnsRun()) throw new RunOwnershipChangedError();
        if (pipelineGuardRetryReset) {
          s.pipelineGuardRetryCount = 0;
        }

        if (isTopLevel) {
          s.pid = null;
          if (result.sessionId) {
            s.sessionId = result.sessionId;
            s.leadSessionId = result.sessionId;
            s.sessionCwd = invocationCwd ?? s.sessionCwd ?? null;
            s.provider = result.provider;
          }
          if (result.error) {
            s.lastError = {
              type: "spawn",
              message: result.error,
              timestamp: Date.now(),
            };
          }

          const pendingMessages = s.pendingMessages;
          if (pendingMessages.length > 0 && s.muted) {
            s.pendingMessages = [];
            s.activePipelineInvocation = null;
            s.status = "idle";
            s.activeTurnAuthor = null;
            s.activeTurnWasInterrupted = false;
            settle.action = "muted-discard";
          } else if (pendingMessages.length > 0) {
            const drained = this.takePendingBatch(pendingMessages);
            s.activeTopLevelMessageTs =
              drained.messages[drained.messages.length - 1]?.ts ??
              s.activeTopLevelMessageTs ??
              null;
            settle.drainPrompt = this.buildDrainPrompt(drained.messages);
            s.pendingMessages = drained.remaining;
            s.activePipelineInvocation = drained.pipelineInvocation;
            s.activeTurnAuthor = null;
            s.activeTurnWasInterrupted = false;
            s.status = "draining";
            settle.action = "drain";
          } else {
            s.activePipelineInvocation = null;
            s.status = "idle";
            s.activeTurnAuthor = null;
            s.activeTurnWasInterrupted = false;
            settle.action = "settle";
          }
        } else {
          const agentSession = this.getOrCreateAgentSession(s, agentName);
          agentSession.pid = null;
          if (result.sessionId) {
            agentSession.sessionId = result.sessionId;
            agentSession.sessionCwd = invocationCwd ?? agentSession.sessionCwd ?? null;
            agentSession.provider = result.provider;
          }
          if (result.error) {
            s.lastError = {
              type: "spawn",
              message: result.error,
              timestamp: Date.now(),
            };
          }

          const pendingMessages = agentSession.pendingMessages;
          if (pendingMessages.length > 0 && s.muted) {
            agentSession.pendingMessages = [];
            agentSession.activePipelineInvocation = null;
            agentSession.status = "idle";
            settle.action = "muted-discard";
          } else if (pendingMessages.length > 0) {
            const drained = this.takePendingBatch(pendingMessages);
            settle.drainPrompt = this.buildDrainPrompt(drained.messages);
            agentSession.pendingMessages = drained.remaining;
            agentSession.activePipelineInvocation = drained.pipelineInvocation;
            agentSession.status = "busy";
            settle.action = "drain";
          } else {
            agentSession.activePipelineInvocation = null;
            agentSession.status = result.error ? "failed" : "done";
            agentSession.lastActivity = Date.now();
            settle.action = "settle";
          }
        }
      });
    } catch (err) {
      if (
        err instanceof RunOwnershipChangedError ||
        (err instanceof Error && err.message.startsWith("session not found:"))
      ) {
        // Row deleted (e.g. !reset) — nothing left to settle.
        return;
      }
      throw err;
    }

    if (settle.action === "drain") {
      this.runRunnerWithAgent(
        settled,
        settle.drainPrompt,
        undefined,
        undefined,
        agentName,
        undefined,
        ownHandle,
      ).catch(async (err) => {
        console.error("[manager] Drain failed:", err);
        try {
          await this.mutateSession(settled.threadId, (s) => {
            if (isTopLevel) {
              s.status = "idle";
            } else {
              const drainAgent = this.getOrCreateAgentSession(s, agentName);
              drainAgent.status = "failed";
            }
          });
        } catch {
          // Session may have been reset during the failed drain.
        }
      });
    } else {
      if (ownHandle && this.handles.get(handleKey) === ownHandle) {
        this.handles.delete(handleKey);
      }
      this.activeTurnSideEffects.delete(handleKey);
    }
    if (settle.action === "settle") {
      await this.onAgentSettled?.(settled, agentName, result.response ?? null);
    }

    if (internalDispatchDirectives.length > 0) {
      await this.dispatchInternalAgentDirectives(
        settled.threadId,
        agentName,
        internalDispatchDirectives,
      );
    }
  }

  /** Keep control-plane dispatches individually attributable while retaining
   * legacy batching for ordinary chat messages. */
  private takePendingBatch(messages: PendingMessage[]): {
    messages: PendingMessage[];
    remaining: PendingMessage[];
    pipelineInvocation: PendingMessage["pipelineInvocation"] | null;
  } {
    const firstPipeline = messages.findIndex((m) => m.pipelineInvocation);
    if (firstPipeline === 0) {
      const [first, ...remaining] = messages;
      return {
        messages: first ? [first] : [],
        remaining,
        pipelineInvocation: first?.pipelineInvocation ?? null,
      };
    }
    if (firstPipeline > 0) {
      return {
        messages: messages.slice(0, firstPipeline),
        remaining: messages.slice(firstPipeline),
        pipelineInvocation: null,
      };
    }
    return { messages: [...messages], remaining: [], pipelineInvocation: null };
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

    // Track human participants for the attention gate. Bots — Junior, its
    // agents, and foreign bots — are excluded by design (see gateAttention).
    // A message reaching here routed to Junior, so the sender is also
    // engaged — their later plain follow-ups must not trip the sidebar
    // trigger. This covers the thread opener, whose first message passes
    // the gate before any session row exists. Goes through mutateSession —
    // a new participant can post while a runner turn is mid-flight, and a
    // whole-row get→set here would revert status/sessionId.
    const isHuman = !event.isSelfBot && !event.botId;
    if (
      isHuman &&
      event.user &&
      (!session.humanParticipants.includes(event.user) ||
        !session.engagedHumans.includes(event.user))
    ) {
      const user = event.user;
      session = await this.mutateSession(event.threadId, (s) => {
        if (!s.humanParticipants.includes(user)) {
          s.humanParticipants.push(user);
        }
        if (!s.engagedHumans.includes(user)) {
          s.engagedHumans.push(user);
        }
      });
    }

    session.leadSessionId ??= session.sessionId;
    session.sessionCwd ??= null;
    session.agentSessions ??= {};
    session.provider ??= "claude";
    session.humanParticipants ??= [];
    session.engagedHumans ??= [];
    session.needsThreadCatchup ??= false;

    return session;
  }

  /**
   * Ordinary work enters the same durable assignment/outbox substrate as a
   * product or bug pipeline. The outbox re-enters handleAgentMessage with an
   * exact pipelineInvocation, so there is only one runner dispatch path.
   */
  private async routeDirectTaskThroughDefaultRun(
    event: SlackMessageEvent,
    agentName: string,
    session: ThreadSession,
  ): Promise<boolean> {
    if (event.pipelineInvocation || !this.pipelineStore) return false;
    if ((this.config.pipeline?.runtimeMode ?? "off") !== "active") return false;

    const durableTarget =
      agentName === "default" && session.agentType && session.agentType !== "lead"
        ? session.agentType
        : agentName;
    const activeId = session.activeRunId ?? session.activePipelineRunId;
    if (activeId) {
      const active = await this.pipelineStore.getRun(activeId);
      if (active && active.status !== "terminal") {
        const assignments = await this.pipelineStore.listAssignments(active.id);
        let assignment = assignments
          .filter((candidate) =>
            candidate.targetAgent === durableTarget &&
            (candidate.status === "pending" ||
              candidate.status === "leased")
          )
          .sort((a, b) => b.updatedAt - a.updatedAt)[0];
        if (!assignment) {
          const parent = [...assignments].sort((a, b) => b.updatedAt - a.updatedAt)[0];
          const assignmentId = crypto.randomUUID();
          assignment = await this.pipelineStore.createAssignmentWithOutbox({
            assignment: {
              id: assignmentId,
              runId: active.id,
              parentAssignmentId: parent?.id ?? null,
              sourceAgent: "human",
              sourceSlackUserId: event.isSelfBot ? null : event.user,
              targetAgent: durableTarget,
              objective: event.text.trim() || "Continue from the latest human input",
              contextRefs: ["control-branch:human-input", `source-message:${event.ts}`],
              artifactRefs: [],
              acceptanceCriteria: active.acceptanceCriteria,
              mutationScope:
                durableTarget === "build" || durableTarget === "frontend"
                  ? ["worktree-code"]
                  : [],
              dependsOn: [],
              attempt: 1,
              attemptId: active.activeAttemptId,
              candidateRevisionDigest: null,
              deadlineAt: active.deadlineAt,
              idempotencyKey: `human-input:${active.id}:${event.ts}:${durableTarget}`,
            },
            outbox: {
              id: crypto.randomUUID(),
              runId: active.id,
              assignmentId,
              eventType: "assignment.resume",
              payload: {
                assignmentId,
                targetAgent: durableTarget,
                prompt: event.text,
                sourceMessageTs: event.ts,
                resumeReason: "human follow-up on active durable task",
              },
              idempotencyKey:
                `default-follow-up:${active.id}:${event.ts}:${durableTarget}`,
            },
          });
        } else {
          await this.pipelineStore.enqueueOutbox({
            id: crypto.randomUUID(),
            runId: active.id,
            assignmentId: assignment.id,
            eventType: "assignment.resume",
            payload: {
              assignmentId: assignment.id,
              targetAgent: assignment.targetAgent,
              prompt: event.text,
              sourceMessageTs: event.ts,
              resumeReason: "human follow-up on active durable task",
            },
            idempotencyKey:
              `default-follow-up:${active.id}:${event.ts}:${durableTarget}`,
          });
        }
        await pumpOutbox({
          store: this.pipelineStore,
          dispatcher: this,
          sessionReader: this.store,
        });
        return true;
      }
    }

    const started = await createDefaultRun(
      { store: this.pipelineStore },
      {
        channelId: event.channel,
        threadId: event.threadId,
        objective: event.text.trim() || `${agentName} task`,
        messageTs: event.ts,
        targetAgent: durableTarget,
        sourceAgent: event.isSelfBot ? "system" : "human",
        sourceSlackUserId: event.isSelfBot ? null : event.user,
        repoRefs: session.targetRepo ? [session.targetRepo] : [],
      },
    );
    await this.mutateSession(event.threadId, (current) => {
      current.activeRunId = started.run.id;
      current.activePipelineRunId = null;
      current.activePipelineKind = null;
    });
    const report = await pumpOutbox({
      store: this.pipelineStore,
      dispatcher: this,
      sessionReader: this.store,
    });
    if (report.failed > 0) {
      _log.warn(
        "default-run",
        `initial dispatch retained for retry run=${started.run.id} errors=${report.errors.join("; ")}`,
      );
    }
    return true;
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
      sessionCwd: null,
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
      sessionCwd: agentSession.sessionCwd ?? null,
      provider: agentSession.provider ?? session.provider ?? this.config.runner.provider,
      agentType: agentName,
      systemPrompt: null,
      status: agentSession.status === "busy" ? "busy" : "idle",
      pendingMessages: agentSession.pendingMessages,
      pid: agentSession.pid,
      lastActivity: agentSession.lastActivity,
      activePipelineInvocation: agentSession.activePipelineInvocation ?? null,
      activeAgentName: agentName,
      slackIdentity: agentIdentity,
    };
  }

  private async attachReviewVerificationPolicy(
    runSession: ThreadSession,
    agentName: string,
  ): Promise<void> {
    if (agentName !== "review" || !runSession.worktreePath) return;
    runSession.verificationPackageManager =
      await detectJavaScriptPackageManager(runSession.worktreePath);
    if (!runSession.verificationPackageManager) {
      _log.warn(
        "manager",
        `review verification disabled: package manager is absent or ambiguous in ${runSession.worktreePath}`,
      );
    }
  }

  /**
   * Return the deterministic Junior-managed worktree for a pipeline repo.
   * Concurrent fan-out can dispatch multiple agents before the first setup
   * finishes, so coalesce creation per repo/thread instead of racing two
   * `git worktree add` processes against the same path and branch.
   */
  private async ensurePipelineWorktree(
    repoName: string,
    threadId: string,
    baseRef?: string,
  ): Promise<string> {
    const manager = this.worktreeManager;
    if (!manager) throw new Error("worktree manager is unavailable");

    const expectedPath = manager.getWorktreePath(repoName, threadId);
    if (await manager.worktreeExists(repoName, threadId)) {
      return expectedPath;
    }

    const key = `${repoName}:${threadId}`;
    const existing = this.worktreeSetups.get(key);
    if (existing) return existing;

    const setup = manager.createWorktree(repoName, threadId, baseRef).then(
      (createdPath) => {
        if (createdPath !== expectedPath) {
          throw new Error(
            `worktree setup returned ${createdPath}; expected managed path ${expectedPath}`,
          );
        }
        return createdPath;
      },
    );
    this.worktreeSetups.set(key, setup);
    try {
      return await setup;
    } finally {
      if (this.worktreeSetups.get(key) === setup) {
        this.worktreeSetups.delete(key);
      }
    }
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

  /**
   * Only real Slack IDs (users/workspace users/foreign bots) get author
   * attribution in prompts. Internal dispatch paths pass synthetic senders
   * ("mcp-internal", "pipeline-internal", "junior-internal-dispatch") or the
   * bot's own user ID; attributing those would emit an unresolvable
   * pseudo-mention or label a worker's task as if Junior were the requester.
   */
  private isAttributableSender(userId: string | undefined): userId is string {
    return (
      !!userId && userId !== this.botUserId && /^[UWB][A-Z0-9]+$/.test(userId)
    );
  }

  /**
   * Format buffered messages for a drain turn. Each message gets its own
   * <buffered-message> block so multi-author drains stay unambiguous: a flat
   * `User(...): text` line per message would collide with the anti-spoofing
   * instruction (only a message's LEADING attribution is authoritative), and
   * message bodies span lines, so line-start labels can't mark boundaries.
   * The `from` mention resolves to `User(Name <@ID>)` downstream; synthetic
   * internal senders get no `from` attribute.
   */
  private buildDrainPrompt(messages: PendingMessage[]): string {
    return messages
      .map((m) => {
        const from = this.isAttributableSender(m.user)
          ? ` from="<@${m.user}>"`
          : "";
        const body = escapeBlockDelimiters(m.text);
        return `<buffered-message${from}>\n${body}\n</buffered-message>`;
      })
      .join("\n");
  }

  private toPendingMessage(event: SlackMessageEvent): PendingMessage {
    return {
      user: event.user,
      text: event.text,
      ts: event.ts,
      command: event.command ?? undefined,
      dedupeKey: event.dedupeKey,
      pipelineInvocation: event.pipelineInvocation,
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

function pipelineAgentRequiresWorktree(agentName: string): boolean {
  const role = resolveAgentManifest(agentName)?.role;
  // Unknown roles fail closed. Trusted orchestrators and planners can perform
  // repo-less discovery/control-plane work; every execution/review role needs
  // a target repository and a Junior-managed worktree.
  return role !== "orchestrator" && role !== "planner";
}

const defaultSpawnRunnerForRuntime: SpawnRunnerFn =
  process.env.NODE_ENV === "test" && process.env.JUNIOR_ALLOW_REAL_RUNNER_IN_TESTS !== "1"
    ? () => {
        throw new Error(
          "SessionManager tests must inject a mock spawnRunner; refusing to launch a real runner.",
        );
      }
    : defaultSpawnRunner;

function formatPipelineSettlementError(
  assignmentId: string,
  recoverySummary: string,
  providerError: string | null,
): string {
  const base =
    `Pipeline assignment ${assignmentId.slice(0, 8)} stopped without reporting a typed outcome ${recoverySummary}. The run was escalated for human attention.`;
  const detail = providerError?.replace(/\s+/g, " ").trim();
  if (!detail) return base;
  return `${base} Provider error: ${detail.slice(0, 500)}`;
}

class RunOwnershipChangedError extends Error {
  constructor() {
    super("runner ownership changed during setup");
    this.name = "RunOwnershipChangedError";
  }
}

function createRunSetupReservation(provider: RunnerProvider): SpawnHandle {
  return {
    provider,
    result: new Promise<SpawnResult>(() => undefined),
    onEvent: () => undefined,
    kill: () => undefined,
    pid: null,
  };
}
