import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { WebClient } from "@slack/web-api";
import {
  escapeBlockDelimiters,
  resolveChannelName,
  resolveSlackMentions,
  resolveUserName,
} from "./thread-context.ts";
import { log } from "../logger.ts";

export interface SlackReplyMessage {
  ts?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  text?: string;
  files?: unknown;
}

export interface ArchivedMessage {
  ts: string;
  roleLabel: string;
  text: string;
  isJunior: boolean;
  timestampUtc: string;
}

export interface ThreadArchiveMeta {
  channelName: string;
  channelId: string;
  threadTs: string;
  archivedAt: string;
  triggeredByUserId: string;
  triggeredByUserName: string;
  totalMessages: number;
  juniorMessageCount: number;
}

export interface ClearThreadOptions {
  client: WebClient;
  channelId: string;
  threadTs: string;
  selfBotId?: string;
  botUserId?: string;
  archiveDir: string;
  triggeredByUserId: string;
}

export interface ClearThreadResult {
  archivePath: string;
  deletedCount: number;
  deleteFailedCount: number;
  totalMessages: number;
  juniorMessageCount: number;
}

export interface DeleteJuniorMessagesResult {
  deletedCount: number;
  failedCount: number;
}

export function isJuniorMessage(
  msg: SlackReplyMessage,
  selfBotId?: string,
  botUserId?: string,
): boolean {
  if (selfBotId && msg.bot_id === selfBotId) return true;
  if (botUserId && msg.user === botUserId) return true;
  return false;
}

export async function fetchFullThreadReplies(
  client: WebClient,
  channel: string,
  threadTs: string,
): Promise<SlackReplyMessage[]> {
  const messages: SlackReplyMessage[] = [];
  let cursor: string | undefined;

  do {
    const result = await client.conversations.replies({
      channel,
      ts: threadTs,
      inclusive: true,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });

    if (result.messages?.length) {
      messages.push(...(result.messages as SlackReplyMessage[]));
    }

    cursor = result.response_metadata?.next_cursor || undefined;
  } while (cursor);

  return messages;
}

function extractFileNames(files: unknown): string[] {
  if (!Array.isArray(files)) return [];
  return files
    .filter((f): f is { name: string } =>
      typeof f === "object" && f !== null && typeof (f as { name?: unknown }).name === "string",
    )
    .map((f) => escapeBlockDelimiters(f.name));
}

function formatTsUtc(ts: string): string {
  const seconds = Number.parseFloat(ts);
  if (!Number.isFinite(seconds)) return ts;
  return new Date(seconds * 1000).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

async function roleLabelForMessage(
  client: WebClient,
  msg: SlackReplyMessage,
  selfBotId?: string,
  botUserId?: string,
): Promise<string> {
  if (isJuniorMessage(msg, selfBotId, botUserId)) {
    if (msg.username) return msg.username;
    return "Junior";
  }
  if (msg.bot_id) return `Bot(${msg.bot_id})`;
  const userId = msg.user ?? "unknown";
  if (userId === "unknown") return "User(unknown)";
  const userName = await resolveUserName(client, userId);
  return `User(${userName} <@${userId}>)`;
}

export async function enrichMessagesForArchive(
  client: WebClient,
  messages: SlackReplyMessage[],
  selfBotId?: string,
  botUserId?: string,
): Promise<ArchivedMessage[]> {
  return Promise.all(
    messages
      .filter((m) => m.ts)
      .map(async (m) => {
        const ts = m.ts!;
        let text = (await resolveSlackMentions(client, m.text ?? "")).trim();
        const fileNames = extractFileNames(m.files);
        if (fileNames.length > 0) {
          const fileNotes = fileNames.map((f) => `[shared file: ${f}]`).join(" ");
          text = text ? `${text} ${fileNotes}` : fileNotes;
        }

        return {
          ts,
          roleLabel: await roleLabelForMessage(client, m, selfBotId, botUserId),
          text,
          isJunior: isJuniorMessage(m, selfBotId, botUserId),
          timestampUtc: formatTsUtc(ts),
        };
      }),
  );
}

function quoteBody(text: string): string {
  if (!text) return "> _(empty)_";
  return text.split("\n").map((line) => `> ${line}`).join("\n");
}

export function formatThreadArchiveMarkdown(
  meta: ThreadArchiveMeta,
  messages: ArchivedMessage[],
): string {
  const channelDisplay = meta.channelName.startsWith("#")
    ? meta.channelName
    : `#${meta.channelName}`;

  const header = [
    "# Thread archive",
    "",
    "| Field | Value |",
    "|---|---|",
    `| Channel | ${channelDisplay} (${meta.channelId}) |`,
    `| Thread | ${meta.threadTs} |`,
    `| Archived at | ${meta.archivedAt} |`,
    `| Triggered by | ${meta.triggeredByUserName} (<@${meta.triggeredByUserId}>) |`,
    `| Messages total | ${meta.totalMessages} |`,
    `| Junior messages deleted | ${meta.juniorMessageCount} |`,
    "",
    "---",
    "",
    "## Messages",
    "",
  ];

  const body = messages.flatMap((m) => [
    `**${m.roleLabel}** · ${m.timestampUtc} · \`${m.ts}\``,
    quoteBody(m.text),
    "",
  ]);

  return [...header, ...body].join("\n").trimEnd() + "\n";
}

export function threadArchiveFilename(
  channelSlug: string,
  threadTs: string,
  archivedAt: Date,
): string {
  const safeChannel = channelSlug.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "channel";
  const safeThread = threadTs.replace(/\./g, "_");
  const date = archivedAt.toISOString().slice(0, 10);
  const shortId = randomBytes(3).toString("hex");
  return `${safeChannel}_${safeThread}_${date}_${shortId}.md`;
}

export async function writeThreadArchive(
  baseDir: string,
  filename: string,
  content: string,
): Promise<string> {
  const archivePath = join(baseDir, filename);
  await mkdir(dirname(archivePath), { recursive: true });
  await writeFile(archivePath, content, "utf8");
  return archivePath;
}

export async function deleteJuniorMessages(
  client: WebClient,
  channelId: string,
  messages: SlackReplyMessage[],
  selfBotId?: string,
  botUserId?: string,
): Promise<DeleteJuniorMessagesResult> {
  let deletedCount = 0;
  let failedCount = 0;

  for (const msg of messages) {
    if (!msg.ts || !isJuniorMessage(msg, selfBotId, botUserId)) continue;
    try {
      await client.chat.delete({ channel: channelId, ts: msg.ts });
      deletedCount++;
    } catch (err) {
      failedCount++;
      log.warn(
        "thread-archive",
        `delete.fail channel=${channelId} ts=${msg.ts} err=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { deletedCount, failedCount };
}

export async function clearThreadJuniorMessages(
  options: ClearThreadOptions,
): Promise<ClearThreadResult> {
  const {
    client,
    channelId,
    threadTs,
    selfBotId,
    botUserId,
    archiveDir,
    triggeredByUserId,
  } = options;

  const rawMessages = await fetchFullThreadReplies(client, channelId, threadTs);
  const archivedMessages = await enrichMessagesForArchive(
    client,
    rawMessages,
    selfBotId,
    botUserId,
  );
  const juniorMessageCount = archivedMessages.filter((m) => m.isJunior).length;
  const archivedAt = new Date();
  const channelName = await resolveChannelName(client, channelId);
  const triggeredByUserName = await resolveUserName(client, triggeredByUserId);

  const meta: ThreadArchiveMeta = {
    channelName,
    channelId,
    threadTs,
    archivedAt: archivedAt.toISOString(),
    triggeredByUserId,
    triggeredByUserName,
    totalMessages: archivedMessages.length,
    juniorMessageCount,
  };

  const markdown = formatThreadArchiveMarkdown(meta, archivedMessages);
  const filename = threadArchiveFilename(channelName, threadTs, archivedAt);
  const archivePath = await writeThreadArchive(archiveDir, filename, markdown);
  const deleteResult = await deleteJuniorMessages(
    client,
    channelId,
    rawMessages,
    selfBotId,
    botUserId,
  );

  return {
    archivePath,
    deletedCount: deleteResult.deletedCount,
    deleteFailedCount: deleteResult.failedCount,
    totalMessages: archivedMessages.length,
    juniorMessageCount,
  };
}
