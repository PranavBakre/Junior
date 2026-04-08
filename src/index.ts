import { App } from "@slack/bolt";
import { loadConfig } from "./config.ts";

const config = loadConfig();

const app = new App({
  token: config.slack.botToken,
  appToken: config.slack.appToken,
  socketMode: true,
  signingSecret: config.slack.signingSecret || undefined,
});

// Echo bot — project-setup iteration 0
app.event("message", async ({ event, say }) => {
  // Ignore bot messages
  if ("bot_id" in event) return;

  const text = "text" in event ? event.text : undefined;
  if (!text) return;

  const threadTs = "thread_ts" in event ? event.thread_ts : event.ts;

  await say({
    text: `Echo: ${text}`,
    thread_ts: threadTs,
  });
});

app.event("app_mention", async ({ event, say }) => {
  const threadTs = event.thread_ts ?? event.ts;

  await say({
    text: `Echo: ${event.text}`,
    thread_ts: threadTs,
  });
});

(async () => {
  await app.start();
  console.log("Junior is running (Socket Mode)");
})();
