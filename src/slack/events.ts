import type { App } from "@slack/bolt";
import type { SessionStore } from "../session/store/interface.ts";
import { parseCommand } from "./commands.ts";
import { isPersistentAgent } from "../support/agents.ts";
import { log } from "../logger.ts";

/**
 * Detect whether a self-bot message contains at least one `!<persistent-agent>`
 * directive line. Used to bypass the self-bot drop guard so an orchestrator
 * agent (e.g. default Junior in #tech) can hand off to a registered worker
 * even in channels that aren't in `autoTriggerChannels`.
 *
 * The check is intentionally narrow — it only matches lines that start with
 * `!<word>` where the word is a known persistent agent. Plain self-bot prose
 * (no directive) continues to drop, preserving the original loop guard.
 */
function containsDispatchDirective(text: string | undefined): boolean {
  if (!text) return false;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^!(\S+)/);
    if (match && isPersistentAgent(match[1])) return true;
  }
  return false;
}

/**
 * Sibling Claude bots (Friday, Doraemon) post their streaming "thinking"
 * updates with a leading ✽ glyph. Drop those — they're not user input, and
 * treating them as input creates cross-bot reply loops.
 */
export function isForeignBotThinking(text: string): boolean {
  return text.trimStart().startsWith("✽");
}

function logDrop(
  reason: string,
  ev: { channel?: string; ts?: string; subtype?: string; thread_ts?: string },
): void {
  const parts = [`dropped reason=${reason}`];
  if (ev.channel) parts.push(`channel=${ev.channel}`);
  if (ev.ts) parts.push(`ts=${ev.ts}`);
  if (ev.thread_ts) parts.push(`thread=${ev.thread_ts}`);
  if (ev.subtype) parts.push(`subtype=${ev.subtype}`);
  log.info("event", parts.join(" "));
}

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
  isSelfBot?: boolean;
  /** Slack bot_id when the message came from any bot (self or foreign). Absent for human posts. */
  botId?: string;
  botUsername?: string;
  /** True when raw Slack text contained `<@selfUserId>` before mention stripping. */
  mentionsJunior?: boolean;
  dedupeKey?: string;
}

export type OnMessageCallback = (event: SlackMessageEvent) => void;

export function registerEventHandlers(
  app: App,
  onMessage: OnMessageCallback,
  store?: SessionStore,
  selfBotId?: string,
  selfUserId?: string,
  autoTriggerChannels?: Set<string>,
): void {
  app.event("message", async ({ event }) => {
    const evMeta = {
      channel: event.channel,
      ts: "ts" in event ? event.ts : undefined,
      subtype: (event as { subtype?: string }).subtype,
      thread_ts: "thread_ts" in event ? event.thread_ts : undefined,
    };

    const isSelfBot =
      "bot_id" in event &&
      selfBotId &&
      (event as { bot_id: string }).bot_id === selfBotId;
    const isAutoTrigger = !!autoTriggerChannels?.has(event.channel);
    const eventText = "text" in event ? event.text : undefined;
    const commandText = eventText ? stripOwnMention(eventText, selfUserId) : undefined;
    const hasDirective = containsDispatchDirective(commandText ?? eventText);

    // Only support auto-trigger channels route our own bot messages; other
    // channels keep the legacy self-filter to avoid ordinary response loops.
    // Exception: self-bot messages that contain a `!<persistent-agent>`
    // directive line are let through so an orchestrator (default Junior or
    // lead) can hand off to a worker from any channel — the directive is the
    // explicit intent signal, so it's no longer "incidental self-bot chatter".
    if (isSelfBot && !isAutoTrigger && !hasDirective) {
      logDrop("self-bot", evMeta);
      return;
    }

    const text = eventText;
    if (!text) {
      logDrop("no-text", evMeta);
      return;
    }

    if (isForeignBotThinking(text)) {
      logDrop("foreign-bot-thinking", evMeta);
      return;
    }

    // Auto-trigger channels (e.g. #bugs-backlog) accept messages from other bots
    // like service-account reporters that have no `user` field — fall back to bot_id.
    let user = "user" in event ? event.user : undefined;
    if (!user && isSelfBot && selfUserId) {
      user = selfUserId;
    }
    if (!user && isAutoTrigger && "bot_id" in event) {
      user = (event as { bot_id?: string }).bot_id;
    }
    if (!user) {
      logDrop("no-user", evMeta);
      return;
    }

    const isThread = "thread_ts" in event && !!event.thread_ts;
    const isDM = event.channel_type === "im";

    if (!isThread && !isDM && !isAutoTrigger && !hasDirective) {
      // Top-level channel message without mention — app_mention handler covers
      // @mentions. `!<agent>` directives are explicit dispatch requests, so
      // don't drop them just because the channel normally requires tagging
      // Junior first.
      logDrop("top-level-no-mention", evMeta);
      return;
    }

    if (isThread && !isAutoTrigger && store && !hasDirective) {
      // Only respond in threads where the bot has an active session
      const threadTs = "thread_ts" in event ? event.thread_ts! : event.ts;
      const session = await store.get(threadTs);
      if (!session) {
        logDrop("no-session", { ...evMeta, thread_ts: threadTs });
        return;
      }
    }

    const threadId =
      "thread_ts" in event && event.thread_ts ? event.thread_ts : event.ts;

    const mentionsJunior = detectSelfMention(text, selfUserId);
    const routingText = commandText ?? text;
    const parsed = parseCommand(routingText);
    const deliveredText = deliveredEventText(text, routingText, parsed);

    // Extract file attachments if present
    const files = extractFiles(event);

    const botId =
      "bot_id" in event && typeof (event as { bot_id?: unknown }).bot_id === "string"
        ? (event as { bot_id: string }).bot_id
        : undefined;

    onMessage({
      threadId,
      channel: event.channel,
      user,
      text: deliveredText,
      ts: event.ts,
      command: parsed.command,
      files: files.length > 0 ? files : undefined,
      isSelfBot: !!isSelfBot,
      botId,
      mentionsJunior,
      botUsername:
        typeof (event as { username?: unknown }).username === "string"
          ? (event as { username: string }).username
          : undefined,
    });
  });

  app.event("app_mention", async ({ event }) => {
    if (!event.user) return;
    if (isForeignBotThinking(event.text)) {
      logDrop("foreign-bot-thinking", {
        channel: event.channel,
        ts: event.ts,
        thread_ts: event.thread_ts,
      });
      return;
    }

    const threadId = event.thread_ts ?? event.ts;

    // app_mention always implies mentionsJunior=true — Slack only fires this
    // event when the bot's user ID is mentioned. Set the flag explicitly so
    // the attention gate's wake-on-mention path works uniformly across both
    // event sources.
    const mentionsJunior = true;
    const routingText = stripOwnMention(event.text, selfUserId);
    const parsed = parseCommand(routingText);
    const deliveredText = deliveredEventText(event.text, routingText, parsed);

    // Extract file attachments if present
    const files = extractFiles(event);

    // Must mirror the `message` handler's bot-flag extraction. The attention
    // gate classifies humans vs bots from `botId` / `isSelfBot`; if a foreign
    // bot @-mentions Junior, the event arrives here, and without these flags
    // the bot's user_id would be added to `humanParticipants` as if it were a
    // human — falsely arming the sidebar trigger.
    const botId =
      "bot_id" in event && typeof (event as { bot_id?: unknown }).bot_id === "string"
        ? (event as { bot_id: string }).bot_id
        : undefined;
    const isSelfBot = !!(botId && selfBotId && botId === selfBotId);

    onMessage({
      threadId,
      channel: event.channel,
      user: event.user,
      text: deliveredText,
      ts: event.ts,
      command: parsed.command,
      files: files.length > 0 ? files : undefined,
      isSelfBot,
      botId,
      mentionsJunior,
    });
  });
}

function detectSelfMention(text: string, selfUserId?: string): boolean {
  if (!selfUserId) return false;
  return text.includes(`<@${selfUserId}>`);
}

function stripOwnMention(text: string, selfUserId?: string): string {
  if (selfUserId) {
    return text
      .replace(new RegExp(`<@${escapeRegExp(selfUserId)}>\\s*`, "g"), "")
      .trim();
  }
  return text.replace(/^<@[A-Z0-9_]+>\s*/g, "").trim();
}

function deliveredEventText(
  originalText: string,
  routingText: string,
  parsed: { command: string | null; text: string },
): string {
  if (parsed.command) return parsed.text;
  if (containsDispatchDirective(routingText)) return routingText;
  return originalText;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
