import { loadConfig } from "./config.ts";
import { createSlackApp } from "./slack/app.ts";
import { registerEventHandlers } from "./slack/events.ts";
import { formatToolStatus } from "./slack/formatting.ts";
import { SlackResponder } from "./slack/responder.ts";
import { SessionManager } from "./session/manager.ts";
import { InMemorySessionStore } from "./session/store/memory.ts";
import { setupGracefulShutdown } from "./lifecycle/shutdown.ts";

const config = loadConfig();
const app = createSlackApp(config);

const store = new InMemorySessionStore();
const sessionManager = new SessionManager(store, config);
const responder = new SlackResponder(app);

sessionManager.onResponse = (session, response) => {
  responder.postResponse(session.channel, session.threadId, response);
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
  console.log(`[command] thread=${event.threadId}`, response);
};

sessionManager.onError = (session, error) => {
  responder.postResponse(
    session.channel,
    session.threadId,
    `Error: ${error ?? "Unknown error"}`,
  );
};

registerEventHandlers(app, (event) => {
  sessionManager.handleMessage(event);
});

setupGracefulShutdown(sessionManager, store);

(async () => {
  await app.start();
  console.log("Junior is running (Socket Mode)");
})();
