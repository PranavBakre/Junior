import { loadConfig } from "./config.ts";
import { resolve } from "node:path";
import { createSlackApp } from "./slack/app.ts";
import { KNOWN_COMMANDS } from "./slack/commands.ts";
import { registerEventHandlers } from "./slack/events.ts";
import {
  extractRunnerMessageText,
  formatRunnerToolStatuses,
  prepareSlackResponse,
  prepareSlackResponseWithActions,
  sanitizeErrorForSlack,
} from "./slack/formatting.ts";
import { SlackResponder } from "./slack/responder.ts";
import { SlackActionStore } from "./slack/action-store.ts";
import {
  disableAgentActionMessages,
  registerAgentActionButtons,
} from "./slack/action-buttons.ts";
import { SessionManager } from "./session/manager.ts";
import { createSessionStore } from "./session/store/factory.ts";
import { setupGracefulShutdown } from "./lifecycle/shutdown.ts";
import { registerHomeTab } from "./slack/home.ts";
import { checkOrphanedSessions } from "./lifecycle/health.ts";
import { cleanupStaleSessions } from "./lifecycle/cleanup.ts";
import { reconcileTmuxSessions } from "./lifecycle/tmux-reconcile.ts";
import { evictIdleTmuxSessions } from "./lifecycle/tmux-evict.ts";
import type { TmuxDriver } from "./claude/tmux-driver.ts";
import { AgentRouter } from "./agents/router.ts";
import { AgentDispatcher } from "./support/router.ts";
import { loadOverlayIdentities } from "./support/agents.ts";
import { WorktreeManager } from "./worktree/manager.ts";
import { DevServerManager } from "./lifecycle/dev-server.ts";
import { DevServerQueue } from "./lifecycle/dev-server-queue.ts";
import { startMcpServer } from "./mcp/slack-server.ts";
import { log } from "./logger.ts";
import { WorkflowController } from "./workflows/controller.ts";
import { WorkflowExecutor } from "./workflows/executor.ts";
import { WorkflowRegistry } from "./workflows/registry.ts";
import { WorkflowScheduler } from "./workflows/scheduler.ts";
import { createMemoryStore } from "./memory/factory.ts";
import { MemoryIngestor } from "./memory/ingestion.ts";
import { startWhatsApp, type WhatsAppHandle } from "./whatsapp/index.ts";
import { setWhatsAppHandle } from "./mcp/whatsapp-tools.ts";
import {
  InMemoryWorkflowStore,
  SqliteWorkflowStore,
  type WorkflowStore,
} from "./workflows/store.ts";
import { createPipelineStore } from "./pipelines/store/factory.ts";
import { pumpOutbox } from "./pipelines/pump.ts";
import {
  reconcileStalePipelineAssignments,
  recoverPipelineRuntime,
} from "./pipelines/recovery.ts";
import { gcTerminalPipelineHistory } from "./pipelines/gc.ts";
import type { PipelineToolRuntime } from "./pipelines/tools.ts";
import type { SlackAuditCallback } from "./pipelines/dispatch.ts";

const config = loadConfig();
const app = createSlackApp(config);

const store = createSessionStore(config);
log.info("boot", `Session store: ${config.session.store}`);
const actionStore = new SlackActionStore(resolve(config.session.sqlitePath));
const memoryStore = createMemoryStore(config.memory.sqlitePath);
const memoryIngestor = new MemoryIngestor(memoryStore);
let pipelineAudit: SlackAuditCallback | undefined;
const sessionManager = new SessionManager(store, config);
sessionManager.setMemoryIngestor(memoryIngestor);
const agentRouter = new AgentRouter(
  config.repos,
  ".claude/agents",
  "agents-org",
);
const worktreeManager = new WorktreeManager(config.repos);
const devServerManager = new DevServerManager(config.repos, worktreeManager);
const devServerQueue = new DevServerQueue(devServerManager, config.repos);

// Pipeline control plane (Phase 2+ substrate). Always construct the store so
// MCP tools can answer; live dispatch/routing only when runtimeMode=active.
const pipelineStore = createPipelineStore({
  kind: config.session.store === "memory" ? "memory" : "sqlite",
  sqlitePath: resolve(config.session.sqlitePath),
});
const pipelineRuntimeMode = config.pipeline?.runtimeMode ?? "off";
const pipelineToolRuntime: PipelineToolRuntime = {
  store: pipelineStore,
  runtimeMode: pipelineRuntimeMode,
  githubTrackingEnabled: config.github?.reconcileEnabled ?? false,
  sessionStore: store,
  productPipelineEnabled: config.pipeline?.productPipelineEnabled ?? false,
  bugPipelineEnabled: config.pipeline?.bugPipelineEnabled ?? false,
  workspaceRoot: process.cwd(),
  repos: config.repos,
  onOutcomeCommitted: async () => {
    // Shadow/off never dispatch — only active mode pumps the outbox.
    if (pipelineRuntimeMode !== "active") return;
    try {
      await pumpOutbox({
        store: pipelineStore,
        dispatcher: sessionManager,
        sessionReader: store,
        audit: pipelineAudit,
      });
    } catch (err) {
      log.warn(
        "pipeline",
        `outbox pump after outcome failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
  onRunStarted: async () => {
    if (pipelineRuntimeMode !== "active") return;
    await pumpOutbox({
      store: pipelineStore,
      dispatcher: sessionManager,
      sessionReader: store,
      audit: pipelineAudit,
      workspaceRoot: process.cwd(),
    });
  },
};
startMcpServer(
  config.slack.botToken,
  store,
  worktreeManager,
  sessionManager,
  actionStore,
  pipelineToolRuntime,
);
sessionManager.agentRouter = agentRouter;
sessionManager.worktreeManager = worktreeManager;
sessionManager.pipelineStore = pipelineStore;
sessionManager.slackApp = app;
const responder = new SlackResponder(app);
pipelineAudit = ({ channelId, threadId, text }) =>
  responder.postResponse(channelId, threadId, text).then(() => undefined);
const autoTriggerChannels = new Set(Object.keys(config.channelDefaults));
// Only channels whose default agent is "lead" go through the support router —
// other auto-trigger channels (e.g., a build channel default) keep the
// existing single-session path.
const supportChannels = new Set(
  Object.entries(config.channelDefaults)
    .filter(([, def]) => def.agentType === "lead")
    .map(([channel]) => channel),
);
const supportRouter = new AgentDispatcher(sessionManager, supportChannels, {
  devServerQueue,
  sessionStore: store,
  slackClient: app.client,
  repos: config.repos,
  pipeline: {
    store: pipelineStore,
    runtimeMode: pipelineRuntimeMode,
    legacyDirectivesEnabled: config.pipeline?.legacyDirectivesEnabled ?? true,
    githubTrackingEnabled: config.github?.reconcileEnabled ?? false,
    bugPipelineEnabled: config.pipeline?.bugPipelineEnabled ?? false,
    productPipelineEnabled: config.pipeline?.productPipelineEnabled ?? false,
    workspaceRoot: process.cwd(),
  },
});
const workflowRegistry = new WorkflowRegistry({
  repos: config.repos,
  builtInCommands: KNOWN_COMMANDS,
});
const workflowStore: WorkflowStore = config.session.store === "memory"
  ? new InMemoryWorkflowStore()
  : new SqliteWorkflowStore(resolve(config.session.sqlitePath));
const workflowExecutor = new WorkflowExecutor({
  config,
  store: workflowStore,
  slackClient: app.client,
  memoryStore,
});
const workflowScheduler = new WorkflowScheduler({
  registry: workflowRegistry,
  store: workflowStore,
  executor: workflowExecutor,
});
const workflowController = new WorkflowController({
  registry: workflowRegistry,
  store: workflowStore,
  scheduler: workflowScheduler,
  slackClient: app.client,
  isAdmin: (userId) => sessionManager.isAdmin(userId),
});

sessionManager.onResponse = async (session, response) => {
  const prepared = prepareSlackResponseWithActions(response);
  const agentName = session.activeAgentName ?? "lead";
  log.info(
    "response",
    `thread=${session.threadId} agent=${agentName} len=${response.length} willPost=${prepared !== null} actions=${prepared?.actions.length ?? 0}`,
  );
  responder.deleteStatus(session.channel, session.threadId, agentName);
  if (prepared !== null) {
    await disableAgentActionMessages(
      actionStore,
      app.client,
      session.threadId,
      agentName,
    );
    const buttonTokens = prepared.actions.map((action) => ({
      action,
      token: crypto.randomUUID(),
    }));
    const posted = await responder.postResponse(
      session.channel,
      session.threadId,
      prepared.text,
      session.slackIdentity,
      buttonTokens.map(({ action, token }) => ({
        token,
        label: action.label,
        style: action.style,
      })),
    );
    const first = posted[0];
    if (first && buttonTokens.length > 0) {
      await actionStore.createMany(
        buttonTokens.map(({ action, token }) => ({
          token,
          channelId: session.channel,
          threadTs: session.threadId,
          messageTs: first.ts,
          messageText: first.text,
          action,
          sourceAgent: agentName,
        })),
      );
    }
  } else {
    log.info(
      "response",
      `thread=${session.threadId} suppressed reason=${response.trim() ? "sentinel" : "empty"}`,
    );
  }
};

sessionManager.onEvent = (session, event) => {
  const agentName = session.activeAgentName ?? "lead";
  if (event.type === "init") {
    log.info("session", `thread=${session.threadId} agent=${agentName} provider=${event.provider} sessionId=${event.sessionId}`);
  }
  if (session.verbosity === "quiet") return;
  if (event.type === "message") {
    // Show text content as live status (gets overwritten each turn)
    const text = extractRunnerMessageText(event);
    if (text) {
      const prepared = prepareSlackResponse(text);
      if (prepared === null) {
        log.info(
          "response",
          `thread=${session.threadId} status.suppressed reason=${text.trim() ? "sentinel" : "empty"}`,
        );
      } else {
        responder.updateStatus(session.channel, session.threadId, prepared, agentName);
      }
    }
    return;
  }

  if (event.type === "tool") {
    // Show tool use as status
    const statuses = formatRunnerToolStatuses(event);
    for (const status of statuses) {
      log.info("tool", `thread=${session.threadId} ${status}`);
      responder.updateStatus(session.channel, session.threadId, status, agentName);
    }
  }
};

sessionManager.onMessageBuffered = (event) => {
  log.info("buffered", `thread=${event.threadId} user=${event.user}`);
  responder.addReaction(event.channel, event.ts, "eyes");
};

sessionManager.onCommandResponse = (event, response) => {
  log.info("command", `thread=${event.threadId} cmd=${event.command} response=${response.slice(0, 100)}`);
  responder.postResponse(event.channel, event.threadId, response);
};

sessionManager.onClearThreadStatus = (threadTs) => {
  responder.clearStatusForThread(threadTs);
};

sessionManager.onReaction = (event, emoji) => {
  responder.addReaction(event.channel, event.ts, emoji);
};

sessionManager.onError = (session, error) => {
  const agentName = session.activeAgentName ?? "lead";
  log.error("error", `thread=${session.threadId} agent=${agentName} ${error ?? "Unknown error"}`);
  const safeError = sanitizeErrorForSlack(error);
  responder.deleteStatus(session.channel, session.threadId, agentName);
  responder.postResponse(
    session.channel,
    session.threadId,
    `Error: ${safeError}`,
    session.slackIdentity,
  );
};

sessionManager.onAgentDispatched = async (session, agentName) => {
  await disableAgentActionMessages(
    actionStore,
    app.client,
    session.threadId,
    agentName,
  );
};

// Review approval must not auto-cleanup worktrees or disable merge/retry
// actions. Cleanup is explicit (Cleanup worktree button) or terminal-pipeline
// only. See docs/features/agent-product-debugging-pipeline-implementation-plan.md Phase 0.

registerHomeTab(app, store, config.session.homeWindowMs, workflowStore);
registerAgentActionButtons(app, actionStore, sessionManager, worktreeManager, {
  supportChannels,
});

// WhatsApp ingestion handle — populated in the async bootstrap when enabled,
// torn down here on shutdown.
let whatsappHandle: WhatsAppHandle | null = null;

setupGracefulShutdown(sessionManager, devServerManager, async () => {
  await workflowScheduler.shutdown();
  workflowRegistry.stopWatching();
  workflowStore.close?.();
  pipelineStore.close?.();
  actionStore.close();
  memoryStore.close();
  if (whatsappHandle) {
    // Detach the MCP tools before closing the store so a late tool call gets
    // the "not enabled" answer instead of a closed-database throw.
    setWhatsAppHandle(null);
    await whatsappHandle.stop();
  }
});

// ---------------------------------------------------------------------------
// Pipeline boot order (mode=off stays safe: reclaim is harmless; no pump/wake)
// 1. stores already open above
// 2. reclaim expired outbox / dev-server / github leases
// 3. optional GitHub reconcile when GITHUB_RECONCILE_ENABLED
// 4. outbox pump only when PIPELINE_RUNTIME_MODE=active (shadow never dispatches)
// 5. retention GC for terminal history (harmless when empty)
// ---------------------------------------------------------------------------
const pipelineBoot = (async () => {
  try {
    const report = await recoverPipelineRuntime(pipelineStore);
    const parts = [
      report.reclaimedOutboxLeases > 0
        ? `outbox=${report.reclaimedOutboxLeases}`
        : null,
      report.reclaimedDevServerLeases > 0
        ? `devserver=${report.reclaimedDevServerLeases}`
        : null,
      report.deadlineReleasedDevServerJobs > 0
        ? `devserver-deadline=${report.deadlineReleasedDevServerJobs}`
        : null,
      report.reclaimedGitHubLeases > 0
        ? `github=${report.reclaimedGitHubLeases}`
        : null,
    ].filter(Boolean);
    if (parts.length > 0) {
      log.info("pipeline", `boot recovery reclaimed ${parts.join(" ")}`);
    }
  } catch (err) {
    log.warn(
      "pipeline",
      `boot recovery failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (pipelineRuntimeMode === "active") {
    try {
      await reconcileStalePipelineAssignments({
        store: pipelineStore,
        sessionReader: store,
        audit: ({ channelId, threadId, text }) =>
          responder.postResponse(channelId, threadId, text).then(() => undefined),
      });
    } catch (err) {
      log.warn(
        "pipeline",
        `boot assignment recovery failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // GitHub observation is independent of pipeline runtime mode, but wakes
  // still require eventWakeEnabled + active controllers in the reconciler.
  if (config.github?.reconcileEnabled) {
    try {
      const { createGitHubClient } = await import("./github/client.ts");
      const { reconcileTrackedResources } = await import(
        "./github/reconciler.ts"
      );
      const client = createGitHubClient({
        token: config.github.reconcileToken ?? undefined,
        useCli: config.github.reconcileUseCli,
      });
      const shadowMode = pipelineRuntimeMode !== "active";
      const eventWakeEnabled =
        (config.github.eventWakeEnabled ?? false) &&
        pipelineRuntimeMode === "active";

      // Track last successful tick so wake-gap detection does not treat every
      // interval pass as a cold startup (which would force-poll everything).
      let lastTickAt: number | null = null;
      const runReconcile = async () => {
        try {
          const pass = await reconcileTrackedResources({
            store: pipelineStore,
            client,
            shadowMode,
            eventWakeEnabled,
            intervalMs: config.github?.reconcileIntervalMs,
            lastTickAt,
            onEventsPersisted: eventWakeEnabled
              ? async (persistResult) => {
                  // Lazy import to avoid loading bug controller when wakes off.
                  const { reduceGitHubEventsForWakes } = await import(
                    "./pipelines/bug/controller.ts"
                  );
                  const assocs =
                    await pipelineStore.listAssociationsForResource(
                      persistResult.resourceId,
                      true,
                    );
                  let wakes = 0;
                  for (const assoc of assocs) {
                    const run = await pipelineStore.getRun(assoc.runId);
                    if (!run || run.status === "terminal") continue;
                    const result = await reduceGitHubEventsForWakes(
                      {
                        store: pipelineStore,
                        eventWakeEnabled: true,
                      },
                      { runId: run.id },
                    );
                    wakes += result.wakesEnqueued;
                  }
                  if (wakes > 0 && pipelineRuntimeMode === "active") {
                    await pumpOutbox({
                      store: pipelineStore,
                      dispatcher: sessionManager,
                      sessionReader: store,
                      audit: pipelineAudit,
                    });
                  }
                  return wakes;
                }
              : undefined,
          });
          lastTickAt = Date.now();
          if (pass.updated > 0 || pass.eventsEmitted > 0 || pass.failures > 0) {
            log.info(
              "github",
              `reconcile examined=${pass.examined} updated=${pass.updated} events=${pass.eventsEmitted} failures=${pass.failures} wakes=${pass.wakesDelivered}`,
            );
          }
        } catch (err) {
          log.warn(
            "github",
            `reconcile pass failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      };

      await runReconcile();
      setInterval(
        () => {
          void runReconcile();
        },
        config.github.reconcileIntervalMs,
      );
      log.info(
        "boot",
        `GitHub reconciler enabled (shadow=${shadowMode} wakes=${eventWakeEnabled})`,
      );
    } catch (err) {
      log.warn(
        "boot",
        `GitHub reconciler failed to start: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (pipelineRuntimeMode === "active") {
    setInterval(() => {
      void (async () => {
        await reconcileStalePipelineAssignments({
          store: pipelineStore,
          sessionReader: store,
          audit: ({ channelId, threadId, text }) =>
            responder.postResponse(channelId, threadId, text).then(() => undefined),
        });
        await pumpOutbox({
          store: pipelineStore,
          dispatcher: sessionManager,
          sessionReader: store,
          audit: pipelineAudit,
        });
      })().catch((err) => {
        log.warn(
          "pipeline",
          `periodic recovery/pump failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, 15_000);
    log.info("boot", "Pipeline outbox pump started (PIPELINE_RUNTIME_MODE=active)");
  } else {
    log.info(
      "boot",
      `Pipeline runtime mode=${pipelineRuntimeMode} (pump/dispatch disabled)`,
    );
  }

  // Retention GC — terminal history only; safe when empty / mode=off.
  try {
    const gcReport = await gcTerminalPipelineHistory({
      store: pipelineStore,
      retentionDays: config.pipeline?.retentionDays ?? 90,
    });
    if (gcReport.runsCompacted > 0) {
      log.info(
        "pipeline",
        `boot GC compacted ${gcReport.runsCompacted} terminal run(s)`,
      );
    }
  } catch (err) {
    log.warn(
      "pipeline",
      `boot GC failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
})();
void pipelineBoot;

// Periodic health checks
setInterval(() => {
  checkOrphanedSessions(store).then((orphaned) => {
    if (orphaned.length > 0) {
      log.warn("health", `Found ${orphaned.length} orphaned sessions: ${orphaned.join(", ")}`);
    }
  });
}, 60_000);

setInterval(() => {
  cleanupStaleSessions(
    store,
    config.session.staleTimeoutMs,
    async (runId, staleBefore) => {
      const run = await pipelineStore.getRun(runId);
      return Boolean(
        run &&
        run.status !== "terminal" &&
        run.updatedAt >= staleBefore,
      );
    },
  ).then((cleaned) => {
    if (cleaned.length > 0) {
      log.info("cleanup", `Removed ${cleaned.length} stale sessions: ${cleaned.join(", ")}`);
    }
  });
}, config.session.cleanupIntervalMs);

// Eviction sweep — kill idle tmux sessions to bound RAM at active-thread scale.
// Conversations resume on the next message via --resume <sessionId>.
const tmuxDriver = sessionManager.driverFor("tmux") as TmuxDriver;
setInterval(() => {
  evictIdleTmuxSessions(store, tmuxDriver, {
    ttlMs: config.claude.tmuxIdleTtlMs,
    skipBusy: true,
  }).catch((err) => {
    log.warn("tmux-evict", `sweep error: ${err instanceof Error ? err.message : String(err)}`);
  });
}, config.claude.tmuxSweepIntervalMs);

(async () => {
  // Load private/overlay agent identities BEFORE accepting events. Each
  // `agents-org/*.md` files may declare `username` + `iconEmoji`/`imageUrl`
  // in frontmatter; those get merged into `AGENT_IDENTITIES` so dispatch,
  // `agentForUsername`, and slack posting all see them. Failure is
  // non-fatal — overlay is optional.
  try {
    await loadOverlayIdentities("agents-org");
  } catch (err) {
    log.error(
      "boot",
      `overlay-identity load failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Bootstrap dev-server worktrees and check for external port conflicts before
  // accepting any Slack events. Failure here is non-fatal — log loudly and
  // continue so other features keep working even if a single repo's worktree
  // setup is broken (missing remote, dirty state, etc.).
  try {
    await devServerManager.bootstrap();
  } catch (err) {
    log.error(
      "boot",
      `dev-server bootstrap failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Reconcile tmux sessions before accepting Slack events. Sessions whose
  // tmux is still alive get reattached; sessions whose tmux died while the
  // bot was down get downgraded so the next turn cold-starts with --resume.
  try {
    await reconcileTmuxSessions(store, tmuxDriver);
  } catch (err) {
    log.error("reconcile", `tmux reconcile threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    await workflowRegistry.startWatching();
    await workflowScheduler.reconcile();
  } catch (err) {
    log.error(
      "workflow",
      `workflow bootstrap failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // WhatsApp ingestion (read-only archive). Incoming messages trigger nothing —
  // the store is only read on demand via the whatsapp_* MCP tools. Non-fatal
  // on failure: a broken pairing/socket must not stop the Slack bot from booting.
  if (config.whatsapp?.enabled) {
    try {
      whatsappHandle = await startWhatsApp(config.whatsapp);
      setWhatsAppHandle(whatsappHandle);
      log.info("boot", "WhatsApp ingestion started");
    } catch (err) {
      log.error(
        "boot",
        `WhatsApp ingestion failed to start: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  await app.start();

  // Resolve bot identity before registering event handlers
  let selfBotId: string | undefined;
  try {
    const auth = await app.client.auth.test();
    if (auth.user_id) {
      sessionManager.botUserId = auth.user_id;
      log.info("boot", `Bot user ID: ${auth.user_id}`);
    }
    if (auth.bot_id) {
      selfBotId = auth.bot_id;
      sessionManager.selfBotId = auth.bot_id;
      log.info("boot", `Bot ID: ${auth.bot_id}`);
    }
  } catch (err) {
    log.warn("boot", `Failed to resolve bot identity: ${err}`);
  }

  registerEventHandlers(app, async (event) => {
    log.info("event", `thread=${event.threadId} user=${event.user} cmd=${event.command ?? "-"} text=${event.text.slice(0, 100)}`);
    // Attention gate FIRST: !aside/!listen and auto-dormant short-circuit
    // before any routing happens. Returns true when the message is consumed
    // here (do not dispatch).
    if (await sessionManager.gateAttention(event)) return;
    if (await workflowController.handleMessage(event)) return;
    // Universal dispatch: AgentDispatcher decides whether to dispatch a persistent
    // agent (any channel) or fall through to the single-session manager.
    await supportRouter.handleMessage(event);
  }, store, selfBotId, sessionManager.botUserId, autoTriggerChannels);

  if (config.http.enabled) {
    // Bun.serve throws synchronously on port conflict (EADDRINUSE) and a few
    // other I/O failures. The dashboard is non-critical — its failure must
    // not bring down the bot before "Junior is running" prints, otherwise
    // Slack disconnects. Mirror the bootstrap try/catch above.
    try {
      const { startHttpServer } = await import("./http/server.ts");
      startHttpServer({
        store,
        config,
        devServerManager,
        devServerQueue,
        repos: config.repos,
        workflowRegistry,
        workflowStore,
        memoryStore,
      });
    } catch (err) {
      log.error(
        "boot",
        `HTTP dashboard failed to start: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  log.info("boot", "Junior is running (Socket Mode)");
})();
