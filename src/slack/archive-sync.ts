import type { EmbeddingProvider } from "../memory/embedding/types.ts";
import type {
  SlackArchiveConversation,
  SlackArchiveFile,
  SlackArchiveMessageInput,
} from "./archive-types.ts";

export type {
  SlackArchiveConversation,
  SlackArchiveFile,
  SlackArchiveMessageInput,
} from "./archive-types.ts";

const CONVERSATION_TYPES = "public_channel,private_channel,im,mpim";

/**
 * The deliberately small store surface needed by history synchronization.
 * Both synchronous SQLite stores and asynchronous stores satisfy it.
 */
export interface ArchiveSyncStore {
  getCheckpoint(channelId: string): string | null | undefined | Promise<string | null | undefined>;
  setCheckpoint(channelId: string, ts: string): void | Promise<void>;
  upsertMessage(message: SlackArchiveMessageInput): unknown | Promise<unknown>;
  upsertConversation?(conversation: SlackArchiveConversation): void | Promise<void>;
  getThreadLatestTimestamps?(
    channelId: string,
  ): Map<string, string> | Promise<Map<string, string>>;
}

interface SlackCursorMetadata {
  next_cursor?: string;
}

export interface SlackConversationResult {
  ok?: boolean;
  error?: string;
  channels?: SlackConversation[];
  response_metadata?: SlackCursorMetadata;
}

export interface SlackHistoryResult {
  ok?: boolean;
  error?: string;
  messages?: SlackMessage[];
  response_metadata?: SlackCursorMetadata;
}

export interface SlackConversation {
  id?: string;
  name?: string;
  is_channel?: boolean;
  is_private?: boolean;
  is_group?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
}

export interface SlackMessageFile {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  url_private?: string;
  permalink?: string;
}

export interface SlackMessage {
  ts?: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  reply_count?: number;
  latest_reply?: string;
  files?: SlackMessageFile[];
}

/** A structural subset of WebClient, kept narrow so synchronization tests need no SDK mock. */
export interface SlackArchiveClient {
  conversations: {
    list(args: {
      types: string;
      exclude_archived: boolean;
      limit: number;
      cursor?: string;
    }): Promise<SlackConversationResult>;
    history(args: {
      channel: string;
      limit: number;
      oldest?: string;
      inclusive?: boolean;
      cursor?: string;
    }): Promise<SlackHistoryResult>;
    replies(args: {
      channel: string;
      ts: string;
      limit: number;
      cursor?: string;
    }): Promise<SlackHistoryResult>;
  };
}

export interface SlackArchiveSyncOptions {
  client: SlackArchiveClient;
  store: ArchiveSyncStore;
  embedder?: EmbeddingProvider;
  pageSize?: number;
  /** Non-public conversations that the operator explicitly approved. */
  approvedChannelIds?: ReadonlySet<string>;
}

export interface SlackArchiveSyncResult {
  channels: number;
  messages: number;
}

export class SlackArchiveSync {
  private readonly pageSize: number;

  constructor(private readonly options: SlackArchiveSyncOptions) {
    this.pageSize = Math.max(1, options.pageSize ?? 200);
  }

  async sync(): Promise<SlackArchiveSyncResult> {
    let channels = 0;
    let messages = 0;
    for await (const conversation of this.listConversations()) {
      channels += 1;
      messages += await this.syncConversation(conversation);
    }
    return { channels, messages };
  }

  private async *listConversations(): AsyncGenerator<SlackArchiveConversation> {
    let cursor: string | undefined;
    do {
      const result = await this.options.client.conversations.list({
        types: CONVERSATION_TYPES,
        exclude_archived: true,
        limit: this.pageSize,
        ...(cursor ? { cursor } : {}),
      });
      assertSlackOk(result, "conversations.list");
      for (const channel of result.channels ?? []) {
        if (!channel.id) continue;
        const conversation: SlackArchiveConversation = {
          id: channel.id,
          name: channel.name ?? null,
          kind: conversationKind(channel),
        };
        if (
          conversation.kind === "public_channel" ||
          this.options.approvedChannelIds?.has(conversation.id) === true
        ) {
          yield conversation;
        }
      }
      cursor = nextCursor(result);
    } while (cursor);
  }

  private async syncConversation(conversation: SlackArchiveConversation): Promise<number> {
    await this.options.store.upsertConversation?.(conversation);
    const checkpoint = await this.options.store.getCheckpoint(conversation.id);
    let cursor: string | undefined;
    // This watermark belongs to conversations.history only. Reply timestamps
    // are from a different cursor domain and must never move `oldest` past a
    // top-level message that history has not returned yet.
    let newestHistoryTs = checkpoint ?? undefined;
    let stored = 0;
    const byTimestamp = new Map<string, SlackMessage>();
    const repairedRoots = new Set<string>();

    // `oldest` is deliberately inclusive. A live event can land immediately
    // before a backfill page; replaying that boundary through an upsert closes
    // the race without creating a duplicate.
    do {
      const result = await this.options.client.conversations.history({
        channel: conversation.id,
        limit: this.pageSize,
        ...(checkpoint ? { oldest: checkpoint, inclusive: true } : {}),
        ...(cursor ? { cursor } : {}),
      });
      assertSlackOk(result, "conversations.history");

      for (const message of result.messages ?? []) {
        if (!message.ts) continue;
        byTimestamp.set(message.ts, message);
        newestHistoryTs = maxSlackTs(newestHistoryTs, message.ts);

        if ((message.reply_count ?? 0) > 0 || message.latest_reply) {
          repairedRoots.add(message.ts);
          for (const reply of await this.fetchReplies(conversation.id, message.ts)) {
            if (!reply.ts) continue;
            byTimestamp.set(reply.ts, reply);
          }
        }
      }

      cursor = nextCursor(result);
    } while (cursor);

    // `conversations.history(oldest=...)` excludes old roots even when they
    // receive a new reply. On incremental runs, page through root metadata once
    // without `oldest`, but call conversations.replies only when Slack's
    // latest_reply is newer than the locally archived thread. This repairs the
    // first or a later missed reply without an N+1 request for every old root.
    if (checkpoint && this.options.store.getThreadLatestTimestamps) {
      const localLatest = await this.options.store.getThreadLatestTimestamps(conversation.id);
      let repairCursor: string | undefined;
      do {
        const result = await this.options.client.conversations.history({
          channel: conversation.id,
          limit: this.pageSize,
          ...(repairCursor ? { cursor: repairCursor } : {}),
        });
        assertSlackOk(result, "conversations.history(reply repair)");
        for (const root of result.messages ?? []) {
          if (!root.ts || repairedRoots.has(root.ts)) continue;
          // Older versions could advance the channel checkpoint with a reply
          // timestamp. If that skipped a root entirely, the full metadata scan
          // is also the recovery path even when the root has no replies.
          if (!localLatest.has(root.ts)) byTimestamp.set(root.ts, root);
          const remoteLatest = root.latest_reply;
          if (!remoteLatest && (root.reply_count ?? 0) === 0) continue;
          const archivedLatest = localLatest.get(root.ts) ?? root.ts;
          if (remoteLatest && compareSlackTs(remoteLatest, archivedLatest) <= 0) continue;
          repairedRoots.add(root.ts);
          for (const reply of await this.fetchReplies(conversation.id, root.ts)) {
            if (reply.ts) byTimestamp.set(reply.ts, reply);
          }
        }
        repairCursor = nextCursor(result);
      } while (repairCursor);
    }

    // Slack history pages arrive newest-first. Canonicalize and write only
    // after every page is collected so the store observes strict chronology
    // across page boundaries as well as within each page.
    const canonical = [...byTimestamp.values()]
      .map((message) => canonicalizeMessage(conversation, message))
      .filter((message): message is SlackArchiveMessageInput => message !== null)
      .sort((left, right) => compareSlackTs(left.ts, right.ts));
    for (let offset = 0; offset < canonical.length; offset += this.pageSize) {
      const chunk = canonical.slice(offset, offset + this.pageSize);
      await this.attachEmbeddings(chunk);
      for (const message of chunk) {
        await this.options.store.upsertMessage(message);
        stored += 1;
      }
    }

    // Advancing the checkpoint is the commit marker for the whole channel.
    // Any history, replies, embedding, or store failure above leaves it alone.
    if (newestHistoryTs !== undefined && newestHistoryTs !== checkpoint) {
      await this.options.store.setCheckpoint(conversation.id, newestHistoryTs);
    }
    return stored;
  }

  private async fetchReplies(channel: string, rootTs: string): Promise<SlackMessage[]> {
    const replies: SlackMessage[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.options.client.conversations.replies({
        channel,
        ts: rootTs,
        limit: this.pageSize,
        ...(cursor ? { cursor } : {}),
      });
      assertSlackOk(result, "conversations.replies");
      replies.push(...(result.messages ?? []));
      cursor = nextCursor(result);
    } while (cursor);
    return replies;
  }

  private async attachEmbeddings(messages: SlackArchiveMessageInput[]): Promise<void> {
    if (!this.options.embedder || messages.length === 0) return;
    const indexes: number[] = [];
    const texts: string[] = [];
    for (let index = 0; index < messages.length; index += 1) {
      if (messages[index]!.text.trim().length === 0) continue;
      indexes.push(index);
      texts.push(messages[index]!.text);
    }
    if (texts.length === 0) return;
    const vectors = await this.options.embedder.embed(texts, "document");
    if (vectors.length !== indexes.length) {
      throw new Error(`Embedding provider returned ${vectors.length} vectors for ${indexes.length} texts`);
    }
    for (let index = 0; index < vectors.length; index += 1) {
      messages[indexes[index]!]!.embedding = vectors[index]!;
      messages[indexes[index]!]!.embedModel = this.options.embedder.model;
      messages[indexes[index]!]!.dim = vectors[index]!.length;
    }
  }
}

export async function syncSlackArchive(
  options: SlackArchiveSyncOptions,
): Promise<SlackArchiveSyncResult> {
  return new SlackArchiveSync(options).sync();
}

export function canonicalizeMessage(
  conversation: SlackArchiveConversation,
  message: SlackMessage,
): SlackArchiveMessageInput | null {
  if (!message.ts) return null;
  return {
    channelId: conversation.id,
    channelName: conversation.name,
    ts: message.ts,
    threadTs: message.thread_ts ?? message.ts,
    userId: message.user ?? null,
    botId: message.bot_id ?? null,
    actorId: message.user ?? message.bot_id ?? null,
    actorKind: message.bot_id ? "bot" : message.user ? "human" : "unknown",
    subtype: message.subtype ?? null,
    text: message.text ?? "",
    files: (message.files ?? []).map(canonicalizeFile),
    embedding: null,
    ingestSource: "backfill",
  };
}

function canonicalizeFile(file: SlackMessageFile): SlackArchiveFile {
  return {
    id: file.id ?? "",
    name: file.name ?? null,
    title: file.title ?? null,
    mimetype: file.mimetype ?? null,
    filetype: file.filetype ?? null,
    size: file.size ?? null,
    urlPrivate: file.url_private ?? null,
    permalink: file.permalink ?? null,
  };
}

function conversationKind(channel: SlackConversation): SlackArchiveConversation["kind"] {
  if (channel.is_im) return "im";
  if (channel.is_mpim) return "mpim";
  if (channel.is_group || channel.is_private) return "private_channel";
  return "public_channel";
}

function assertSlackOk(result: { ok?: boolean; error?: string }, method: string): void {
  if (result.ok === false) throw new Error(`${method} failed: ${result.error ?? "unknown_error"}`);
}

function nextCursor(result: { response_metadata?: SlackCursorMetadata }): string | undefined {
  const cursor = result.response_metadata?.next_cursor?.trim();
  return cursor || undefined;
}

function maxSlackTs(current: string | undefined, candidate: string): string {
  return current === undefined || compareSlackTs(candidate, current) > 0 ? candidate : current;
}

/** Compare Slack's seconds.microseconds timestamps without floating-point loss. */
export function compareSlackTs(left: string, right: string): number {
  const leftValue = slackTsValue(left);
  const rightValue = slackTsValue(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function slackTsValue(ts: string): bigint {
  const [seconds = "0", fraction = ""] = ts.split(".", 2);
  const micros = fraction.slice(0, 6).padEnd(6, "0");
  try {
    return BigInt(seconds) * 1_000_000n + BigInt(micros);
  } catch {
    throw new Error(`Invalid Slack timestamp: ${ts}`);
  }
}
