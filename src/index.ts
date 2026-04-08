import { loadConfig } from "./config.ts";
import { createSlackApp } from "./slack/app.ts";
import { registerEventHandlers } from "./slack/events.ts";

const config = loadConfig();
const app = createSlackApp(config);

registerEventHandlers(app, (event) => {
  console.log("[event]", JSON.stringify(event, null, 2));
});

(async () => {
  await app.start();
  console.log("Junior is running (Socket Mode)");
})();
