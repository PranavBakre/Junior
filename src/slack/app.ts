import { App } from "@slack/bolt";
import type { Config } from "../config.ts";

export function createSlackApp(config: Config): App {
  return new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    socketMode: true,
    signingSecret: config.slack.signingSecret || undefined,
    // Receive our own bot's posts as events. The bug pipeline depends on this:
    // lead emits !<agent> directives by posting Slack messages via the slack-bot
    // MCP, and the router parses them from the resulting message event. With
    // Bolt's default ignoreSelf=true, those events would be filtered out and
    // directives silently dropped. events.ts has explicit isSelfBot handling
    // (drop self-bot messages in non-auto-trigger channels to prevent loops).
    ignoreSelf: false,
  });
}
