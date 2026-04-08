import type { App } from "@slack/bolt";
import { parseCommand } from "./commands.ts";

export interface SlackMessageEvent {
  threadId: string;
  channel: string;
  user: string;
  text: string;
  ts: string;
  command: string | null;
}

export type OnMessageCallback = (event: SlackMessageEvent) => void;

export function registerEventHandlers(
  app: App,
  onMessage: OnMessageCallback
): void {
  app.event("message", async ({ event }) => {
    // Filter out bot messages
    if ("bot_id" in event) return;

    const text = "text" in event ? event.text : undefined;
    if (!text) return;

    const user = "user" in event ? event.user : undefined;
    if (!user) return;

    const threadId =
      "thread_ts" in event && event.thread_ts ? event.thread_ts : event.ts;

    const parsed = parseCommand(text);

    onMessage({
      threadId,
      channel: event.channel,
      user,
      text: parsed.text,
      ts: event.ts,
      command: parsed.command,
    });
  });

  app.event("app_mention", async ({ event }) => {
    if (!event.user) return;

    const threadId = event.thread_ts ?? event.ts;

    // Strip bot mention from text (Slack includes <@BOTID> in app_mention events)
    const cleanText = event.text.replace(/<@[A-Z0-9]+>\s*/g, "").trim();
    const parsed = parseCommand(cleanText);

    onMessage({
      threadId,
      channel: event.channel,
      user: event.user,
      text: parsed.text,
      ts: event.ts,
      command: parsed.command,
    });
  });
}
