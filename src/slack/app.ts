import { App } from "@slack/bolt";
import type { Config } from "../config.ts";

export function createSlackApp(config: Config): App {
  return new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    socketMode: true,
    signingSecret: config.slack.signingSecret || undefined,
  });
}
