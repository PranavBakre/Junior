import { loadConfig } from "./config.ts";
import { createSlackApp } from "./slack/app.ts";
import { registerEventHandlers } from "./slack/events.ts";
import { formatToolStatus } from "./slack/formatting.ts";
import { SlackResponder } from "./slack/responder.ts";
import { SessionManager } from "./session/manager.ts";
import { InMemorySessionStore } from "./session/store/memory.ts";
import { setupGracefulShutdown } from "./lifecycle/shutdown.ts";
import { registerHomeTab } from "./slack/home.ts";
import { checkOrphanedSessions } from "./lifecycle/health.ts";
import { cleanupStaleSessions } from "./lifecycle/cleanup.ts";
import { AgentRouter } from "./agents/router.ts";
import { WorktreeManager } from "./worktree/manager.ts";

const config = loadConfig();
const app = createSlackApp(config);

const store = new InMemorySessionStore();
const sessionManager = new SessionManager(store, config);
const agentRouter = new AgentRouter(config.repos, ".claude/agents");
const worktreeManager = new WorktreeManager(config.repos);
sessionManager.agentRouter = agentRouter;
sessionManager.worktreeManager = worktreeManager;
const responder = new SlackResponder(app);

sessionManager.onResponse = (session, response) => {
  responder.deleteStatus(session.channel, session.threadId);
  if (response) {
    responder.postResponse(session.channel, session.threadId, response);
  }
};

sessionManager.onEvent = (session, event) => {
  if (session.verbosity === "quiet") return;
  if (event.type === "assistant" && event.subtype === "tool_use") {
    responder.updateStatus(
      session.channel,
      session.threadId,
      formatToolStatus(event),
    );
  }
};

sessionManager.onMessageBuffered = (event) => {
  responder.addReaction(event.channel, event.ts, "eyes");
};

sessionManager.onCommandResponse = (event, response) => {
  responder.postResponse(event.channel, event.threadId, response);
};

sessionManager.onError = (session, error) => {
  responder.deleteStatus(session.channel, session.threadId);
  responder.postResponse(
    session.channel,
    session.threadId,
    `Error: ${error ?? "Unknown error"}`,
  );
};

registerEventHandlers(app, (event) => {
  sessionManager.handleMessage(event);
}, store);

registerHomeTab(app, store);

setupGracefulShutdown(sessionManager, store);

// Periodic health checks
setInterval(() => {
  checkOrphanedSessions(store).then((orphaned) => {
    if (orphaned.length > 0) {
      console.log(`[health] Found ${orphaned.length} orphaned sessions:`, orphaned);
    }
  });
}, 60_000);

setInterval(() => {
  cleanupStaleSessions(store, config.session.staleTimeoutMs).then((cleaned) => {
    if (cleaned.length > 0) {
      console.log(`[cleanup] Removed ${cleaned.length} stale sessions:`, cleaned);
    }
  });
}, config.session.cleanupIntervalMs);

(async () => {
  await app.start();
  console.log("Junior is running (Socket Mode)");
})();
