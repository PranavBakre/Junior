import { loadConfig } from "./config.ts";
import { createSlackApp } from "./slack/app.ts";
import { registerEventHandlers } from "./slack/events.ts";
import { formatToolStatuses, extractAssistantText, shouldPostResponseToSlack } from "./slack/formatting.ts";
import { SlackResponder } from "./slack/responder.ts";
import { SessionManager } from "./session/manager.ts";
import { createSessionStore } from "./session/store/factory.ts";
import { setupGracefulShutdown } from "./lifecycle/shutdown.ts";
import { registerHomeTab } from "./slack/home.ts";
import { checkOrphanedSessions } from "./lifecycle/health.ts";
import { cleanupStaleSessions } from "./lifecycle/cleanup.ts";
import { AgentRouter } from "./agents/router.ts";
import { AgentDispatcher } from "./support/router.ts";
import { WorktreeManager } from "./worktree/manager.ts";
import { DevServerManager } from "./lifecycle/dev-server.ts";
import { DevServerQueue } from "./lifecycle/dev-server-queue.ts";
import { startMcpServer } from "./mcp/slack-server.ts";
import { log } from "./logger.ts";

const config = loadConfig();
const app = createSlackApp(config);

const store = createSessionStore(config);
log.info("boot", `Session store: ${config.session.store}`);
const sessionManager = new SessionManager(store, config);
const agentRouter = new AgentRouter(config.repos, ".claude/agents");
const worktreeManager = new WorktreeManager(config.repos);
const devServerManager = new DevServerManager(config.repos, worktreeManager);
const devServerQueue = new DevServerQueue(devServerManager, config.repos);
startMcpServer(config.slack.botToken, store, worktreeManager);
sessionManager.agentRouter = agentRouter;
sessionManager.worktreeManager = worktreeManager;
sessionManager.slackApp = app;
const responder = new SlackResponder(app);
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
});

sessionManager.onResponse = (session, response) => {
  const willPost = shouldPostResponseToSlack(response);
  const agentName = session.activeAgentName ?? "lead";
  log.info(
    "response",
    `thread=${session.threadId} agent=${agentName} len=${response.length} willPost=${willPost}`,
  );
  responder.deleteStatus(session.channel, session.threadId, agentName);
  if (willPost) {
    responder.postResponse(
      session.channel,
      session.threadId,
      response,
      session.slackIdentity,
    );
  } else {
    log.info(
      "response",
      `thread=${session.threadId} suppressed reason=${response.trim() ? "sentinel" : "empty"}`,
    );
  }
};

sessionManager.onEvent = (session, event) => {
  const agentName = session.activeAgentName ?? "lead";
  if (event.type === "system" && event.subtype === "init") {
    log.info("session", `thread=${session.threadId} agent=${agentName} sessionId=${session.sessionId}`);
  }
  if (session.verbosity === "quiet") return;
  if (event.type === "assistant") {
    // Show text content as live status (gets overwritten each turn)
    const text = extractAssistantText(event);
    if (text && !shouldPostResponseToSlack(text)) {
      log.info(
        "response",
        `thread=${session.threadId} status.suppressed reason=${text.trim() ? "sentinel" : "empty"}`,
      );
    }
    if (text && shouldPostResponseToSlack(text)) {
      responder.updateStatus(session.channel, session.threadId, text, agentName);
    }

    // Show tool use as status
    const statuses = formatToolStatuses(event);
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

sessionManager.onError = (session, error) => {
  const agentName = session.activeAgentName ?? "lead";
  log.error("error", `thread=${session.threadId} agent=${agentName} ${error ?? "Unknown error"}`);
  responder.deleteStatus(session.channel, session.threadId, agentName);
  responder.postResponse(
    session.channel,
    session.threadId,
    `Error: ${error ?? "Unknown error"}`,
    session.slackIdentity,
  );
};

registerHomeTab(app, store, config.session.homeWindowMs);

setupGracefulShutdown(sessionManager, store, devServerManager);

// Periodic health checks
setInterval(() => {
  checkOrphanedSessions(store).then((orphaned) => {
    if (orphaned.length > 0) {
      log.warn("health", `Found ${orphaned.length} orphaned sessions: ${orphaned.join(", ")}`);
    }
  });
}, 60_000);

setInterval(() => {
  cleanupStaleSessions(store, config.session.staleTimeoutMs).then((cleaned) => {
    if (cleaned.length > 0) {
      log.info("cleanup", `Removed ${cleaned.length} stale sessions: ${cleaned.join(", ")}`);
    }
  });
}, config.session.cleanupIntervalMs);

(async () => {
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
      log.info("boot", `Bot ID: ${auth.bot_id}`);
    }
  } catch (err) {
    log.warn("boot", `Failed to resolve bot identity: ${err}`);
  }

  registerEventHandlers(app, (event) => {
    log.info("event", `thread=${event.threadId} user=${event.user} cmd=${event.command ?? "-"} text=${event.text.slice(0, 100)}`);
    // Universal dispatch: AgentDispatcher decides whether to dispatch a persistent
    // agent (any channel) or fall through to the single-session manager.
    supportRouter.handleMessage(event);
  }, store, selfBotId, sessionManager.botUserId, autoTriggerChannels);

  if (config.http.enabled) {
    const { startHttpServer } = await import("./http/server.ts");
    startHttpServer({
      store,
      config,
      devServerManager,
      devServerQueue,
      repos: config.repos,
    });
  }

  log.info("boot", "Junior is running (Socket Mode)");
})();
