import { loadConfig } from "./config.ts";
import { createSlackApp } from "./slack/app.ts";
import { registerEventHandlers } from "./slack/events.ts";
import { InMemorySessionStore } from "./session/store/memory.ts";
import { SessionManager } from "./session/manager.ts";

const config = loadConfig();
const app = createSlackApp(config);

const store = new InMemorySessionStore();
const sessionManager = new SessionManager(store, config);

sessionManager.onResponse = (session, response) => {
  console.log(`[response] thread=${session.threadId}`, response.slice(0, 200));
};

sessionManager.onMessageBuffered = (event) => {
  console.log(`[buffered] thread=${event.threadId} from=${event.user}`);
};

registerEventHandlers(app, (event) => {
  sessionManager.handleMessage(event);
});

(async () => {
  await app.start();
  console.log("Junior is running (Socket Mode)");
})();
