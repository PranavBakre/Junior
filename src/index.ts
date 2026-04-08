import { loadConfig } from "./config.ts";
import { createSlackApp } from "./slack/app.ts";
import { registerEventHandlers } from "./slack/events.ts";
import { formatToolStatuses, extractAssistantText } from "./slack/formatting.ts";
import { SlackResponder } from "./slack/responder.ts";
import { SessionManager } from "./session/manager.ts";
import { InMemorySessionStore } from "./session/store/memory.ts";
import { setupGracefulShutdown } from "./lifecycle/shutdown.ts";
import { registerHomeTab } from "./slack/home.ts";
import { checkOrphanedSessions } from "./lifecycle/health.ts";
import { cleanupStaleSessions } from "./lifecycle/cleanup.ts";
import { AgentRouter } from "./agents/router.ts";
import { WorktreeManager } from "./worktree/manager.ts";
import { log } from "./logger.ts";

const config = loadConfig();
const app = createSlackApp(config);

const store = new InMemorySessionStore();
const sessionManager = new SessionManager(store, config);
const agentRouter = new AgentRouter(config.repos, ".claude/agents");
const worktreeManager = new WorktreeManager(config.repos);
sessionManager.agentRouter = agentRouter;
sessionManager.worktreeManager = worktreeManager;
sessionManager.slackApp = app;
const responder = new SlackResponder(app);

sessionManager.onResponse = (session, response) => {
  log.info("response", `thread=${session.threadId} len=${response.length}`);
  responder.deleteStatus(session.channel, session.threadId);
  if (response) {
    responder.postResponse(session.channel, session.threadId, response);
  }
};

sessionManager.onEvent = (session, event) => {
  if (event.type === "system" && event.subtype === "init") {
    log.info("session", `thread=${session.threadId} sessionId=${session.sessionId}`);
  }
  if (session.verbosity === "quiet") return;
  if (event.type === "assistant") {
    // Show text content as live status (gets overwritten each turn)
    const text = extractAssistantText(event);
    if (text) {
      responder.updateStatus(session.channel, session.threadId, text);
    }

    // Show tool use as status
    const statuses = formatToolStatuses(event);
    for (const status of statuses) {
      log.info("tool", `thread=${session.threadId} ${status}`);
      responder.updateStatus(session.channel, session.threadId, status);
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
  log.error("error", `thread=${session.threadId} ${error ?? "Unknown error"}`);
  responder.deleteStatus(session.channel, session.threadId);
  responder.postResponse(
    session.channel,
    session.threadId,
    `Error: ${error ?? "Unknown error"}`,
  );
};

registerHomeTab(app, store);

setupGracefulShutdown(sessionManager, store);

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
    sessionManager.handleMessage(event);
  }, store, selfBotId);

  log.info("boot", "Junior is running (Socket Mode)");
})();
