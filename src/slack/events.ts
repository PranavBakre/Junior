import type { App } from "@slack/bolt";
import type { SessionStore } from "../session/store/interface.ts";
import { parseCommand } from "./commands.ts";

export interface SlackFileAttachment {
  url: string;
  name: string;
  mimetype: string;
}

export interface SlackMessageEvent {
  threadId: string;
  channel: string;
  user: string;
  text: string;
  ts: string;
  command: string | null;
  files?: SlackFileAttachment[];
}

export type OnMessageCallback = (event: SlackMessageEvent) => void;

export function registerEventHandlers(
  app: App,
  onMessage: OnMessageCallback,
  store?: SessionStore,
  selfBotId?: string,
): void {
  app.event("message", async ({ event }) => {
    // Only filter our own bot messages to avoid loops; let other bots through
    if ("bot_id" in event && selfBotId && (event as { bot_id: string }).bot_id === selfBotId) return;

    const text = "text" in event ? event.text : undefined;
    if (!text) return;

    const user = "user" in event ? event.user : undefined;
    if (!user) return;

    const isThread = "thread_ts" in event && !!event.thread_ts;
    const isDM = event.channel_type === "im";

    if (!isThread && !isDM) {
      // Top-level channel message without mention — ignore.
      // app_mention handler covers @mentions.
      return;
    }

    if (isThread && store) {
      // Only respond in threads where the bot has an active session
      const threadTs = "thread_ts" in event ? event.thread_ts! : event.ts;
      const session = await store.get(threadTs);
      if (!session) return;
    }

    const threadId =
      "thread_ts" in event && event.thread_ts ? event.thread_ts : event.ts;

    // Strip bot mention so commands are recognized even from the message event
    const cleanText = selfBotId
      ? text.replace(/<@[A-Z0-9]+>\s*/g, "").trim()
      : text;
    const parsed = parseCommand(cleanText);

    // Extract file attachments if present
    const files = extractFiles(event);

    onMessage({
      threadId,
      channel: event.channel,
      user,
      text: parsed.text,
      ts: event.ts,
      command: parsed.command,
      files: files.length > 0 ? files : undefined,
    });
  });

  app.event("app_mention", async ({ event }) => {
    if (!event.user) return;

    const threadId = event.thread_ts ?? event.ts;

    // Strip bot mention from text (Slack includes <@BOTID> in app_mention events)
    const cleanText = event.text.replace(/<@[A-Z0-9]+>\s*/g, "").trim();
    const parsed = parseCommand(cleanText);

    // Extract file attachments if present
    const files = extractFiles(event);

    onMessage({
      threadId,
      channel: event.channel,
      user: event.user,
      text: parsed.text,
      ts: event.ts,
      command: parsed.command,
      files: files.length > 0 ? files : undefined,
    });
  });
}

/**
 * Extract file attachments from a Slack event.
 * Slack events with files have a `files` array with url_private_download, mimetype, and name.
 * We use `unknown` and cast via intermediate object since Bolt's event types don't include `files`.
 */
function extractFiles(event: unknown): SlackFileAttachment[] {
  const ev = event as { files?: unknown[] };
  if (!Array.isArray(ev.files)) return [];

  return (ev.files as Array<Record<string, unknown>>)
    .filter(
      (f) =>
        typeof f.url_private_download === "string" &&
        typeof f.mimetype === "string" &&
        typeof f.name === "string",
    )
    .map((f) => ({
      url: f.url_private_download as string,
      name: f.name as string,
      mimetype: f.mimetype as string,
    }));
}
