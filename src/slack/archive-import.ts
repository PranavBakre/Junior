import type {
  SlackArchiveActorKind,
  SlackArchiveConversation,
  SlackArchiveFile,
  SlackArchiveMessageInput,
  SlackArchiveWriteResult,
} from "./archive-types.ts";
import { compareSlackTs } from "./archive-sync.ts";

export interface SlackArchiveImportStore {
  upsertMessages(messages: SlackArchiveMessageInput[]): SlackArchiveWriteResult[] | Promise<SlackArchiveWriteResult[]>;
  setCheckpoint(channelId: string, latestTs: string): void | Promise<void>;
  upsertConversation?(conversation: SlackArchiveConversation): void | Promise<void>;
}

/** Injection seam for tests and for alternate ZIP implementations. */
export interface SlackExportReader {
  listEntries(): Promise<string[]>;
  readJson(entry: string): Promise<unknown>;
}

export interface SlackArchiveImportOptions {
  zipPath?: string;
  reader?: SlackExportReader;
  store: SlackArchiveImportStore;
  dryRun?: boolean;
  batchSize?: number;
  /** Non-public conversations that the operator explicitly approved. */
  approvedChannelIds?: ReadonlySet<string>;
}

export interface SlackArchiveImportReport {
  dryRun: boolean;
  channels: number;
  files: number;
  messagesSeen: number;
  messagesValid: number;
  messagesSkipped: number;
  inserted: number;
  updated: number;
  deduped: number;
  checkpoints: number;
}

interface ExportChannel {
  id?: string;
  name?: string;
  members?: string[];
  is_archived?: boolean;
}

interface ExportUser {
  id?: string;
  name?: string;
  real_name?: string;
  is_bot?: boolean;
  is_app_user?: boolean;
  profile?: { display_name?: string; real_name?: string; bot_id?: string };
}

interface ExportMessage {
  type?: string;
  ts?: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  app_id?: string;
  username?: string;
  subtype?: string;
  text?: string;
  client_msg_id?: string;
  team?: string;
  files?: Array<{
    id?: string;
    name?: string;
    title?: string;
    mimetype?: string;
    filetype?: string;
    size?: number;
    url_private?: string;
    permalink?: string;
  }>;
}

/** Reads individual members with `unzip -p`; no archive contents touch disk. */
export class UnzipSlackExportReader implements SlackExportReader {
  constructor(private readonly zipPath: string) {}

  async listEntries(): Promise<string[]> {
    const text = await runUnzip(["-Z1", this.zipPath]);
    return text.split(/\r?\n/).filter(Boolean);
  }

  async readJson(entry: string): Promise<unknown> {
    return JSON.parse(await runUnzip(["-p", this.zipPath, entry]));
  }
}

export async function importSlackArchive(
  options: SlackArchiveImportOptions,
): Promise<SlackArchiveImportReport> {
  if (!options.reader && !options.zipPath) {
    throw new Error("Slack archive import requires zipPath or reader");
  }
  const reader = options.reader ?? new UnzipSlackExportReader(options.zipPath!);
  const entries = await reader.listEntries();
  const entrySet = new Set(entries);
  const dryRun = options.dryRun ?? false;
  const batchSize = Math.max(1, options.batchSize ?? 500);
  const users = await loadUsers(reader, entrySet);
  const channels = await loadChannels(reader, entrySet, users);
  const messageFiles = entries
    .map(parseMessageEntry)
    .filter((entry): entry is { path: string; directory: string } => entry !== null);
  const byDirectory = new Map<string, string[]>();
  for (const file of messageFiles) {
    const paths = byDirectory.get(file.directory) ?? [];
    paths.push(file.path);
    byDirectory.set(file.directory, paths);
  }

  const report: SlackArchiveImportReport = {
    dryRun,
    channels: byDirectory.size,
    files: messageFiles.length,
    messagesSeen: 0,
    messagesValid: 0,
    messagesSkipped: 0,
    inserted: 0,
    updated: 0,
    deduped: 0,
    checkpoints: 0,
  };

  for (const [directory, paths] of byDirectory) {
    const conversation = channels.get(directory) ?? fallbackConversation(directory);
    if (
      conversation.kind !== "public_channel" &&
      options.approvedChannelIds?.has(conversation.id) !== true
    ) {
      continue;
    }
    if (!dryRun) await options.store.upsertConversation?.(conversation);
    let latestTs: string | undefined;
    const batch: SlackArchiveMessageInput[] = [];
    paths.sort();

    for (const path of paths) {
      const raw = await reader.readJson(path);
      if (!Array.isArray(raw)) throw new Error(`Slack export member is not a message array: ${path}`);
      const canonical: SlackArchiveMessageInput[] = [];
      for (const candidate of raw) {
        report.messagesSeen += 1;
        const message = canonicalizeExportMessage(conversation, candidate, users);
        if (!message) {
          report.messagesSkipped += 1;
          continue;
        }
        report.messagesValid += 1;
        if (
          message.threadTs === message.ts &&
          (!latestTs || compareSlackTs(message.ts, latestTs) > 0)
        ) {
          latestTs = message.ts;
        }
        if (!dryRun) canonical.push(message);
      }
      canonical.sort((left, right) => compareSlackTs(left.ts, right.ts));
      for (const message of canonical) {
        batch.push(message);
        if (batch.length >= batchSize) await flushBatch(options.store, batch, report);
      }
    }
    if (!dryRun) {
      await flushBatch(options.store, batch, report);
      // This is a per-channel commit marker. If parsing or writing any daily
      // member fails, the checkpoint remains at its prior safe position.
      if (latestTs) {
        await options.store.setCheckpoint(conversation.id, latestTs);
        report.checkpoints += 1;
      }
    }
  }
  return report;
}

export function canonicalizeExportMessage(
  conversation: SlackArchiveConversation,
  raw: unknown,
  users: ReadonlyMap<string, ExportUser>,
): SlackArchiveMessageInput | null {
  if (!isRecord(raw)) return null;
  const message = raw as ExportMessage;
  if (message.type !== undefined && message.type !== "message") return null;
  if (typeof message.ts !== "string" || message.ts.length === 0) return null;
  const user = message.user ? users.get(message.user) : undefined;
  const botId = message.bot_id ?? user?.profile?.bot_id ?? null;
  const actorId = message.user ?? botId;
  const eventTimeMs = slackTsToMs(message.ts);
  return {
    channelId: conversation.id,
    channelName: conversation.name,
    ts: message.ts,
    threadTs: message.thread_ts ?? message.ts,
    userId: message.user ?? null,
    botId,
    actorId,
    actorName: message.username ?? userDisplayName(user) ?? null,
    actorKind: actorKind(user, botId, message.subtype),
    text: typeof message.text === "string" ? message.text : "",
    files: Array.isArray(message.files) ? message.files.map(canonicalizeExportFile) : [],
    subtype: message.subtype ?? null,
    metadata: {
      ...(message.app_id ? { appId: message.app_id } : {}),
      ...(message.client_msg_id ? { clientMsgId: message.client_msg_id } : {}),
      ...(message.team ? { teamId: message.team } : {}),
      ...(message.username ? { botUsername: message.username } : {}),
    },
    embedding: null,
    ingestSource: "backfill",
    // Export observations predate any subsequent live event. Event time is a
    // stable value across reruns, so importing the same ZIP is idempotent and
    // cannot overwrite a newer live observation of the same message.
    observedAt: eventTimeMs,
    eventTimeMs,
  };
}

async function flushBatch(
  store: SlackArchiveImportStore,
  batch: SlackArchiveMessageInput[],
  report: SlackArchiveImportReport,
): Promise<void> {
  if (batch.length === 0) return;
  const rows = batch.splice(0, batch.length);
  const results = await store.upsertMessages(rows);
  for (const result of results) report[result] += 1;
}

async function loadUsers(
  reader: SlackExportReader,
  entries: ReadonlySet<string>,
): Promise<Map<string, ExportUser>> {
  const users = new Map<string, ExportUser>();
  if (!entries.has("users.json")) return users;
  const raw = await reader.readJson("users.json");
  if (!Array.isArray(raw)) throw new Error("Slack export users.json is not an array");
  for (const candidate of raw) {
    if (!isRecord(candidate) || typeof candidate.id !== "string") continue;
    users.set(candidate.id, candidate as ExportUser);
  }
  return users;
}

async function loadChannels(
  reader: SlackExportReader,
  entries: ReadonlySet<string>,
  users: ReadonlyMap<string, ExportUser>,
): Promise<Map<string, SlackArchiveConversation>> {
  const channels = new Map<string, SlackArchiveConversation>();
  const manifests: Array<[string, SlackArchiveConversation["kind"]]> = [
    ["channels.json", "public_channel"],
    ["groups.json", "private_channel"],
    ["dms.json", "im"],
    ["mpims.json", "mpim"],
  ];
  for (const [entry, kind] of manifests) {
    if (!entries.has(entry)) continue;
    const raw = await reader.readJson(entry);
    if (!Array.isArray(raw)) throw new Error(`Slack export ${entry} is not an array`);
    for (const candidate of raw) {
      if (!isRecord(candidate) || typeof candidate.id !== "string") continue;
      const id = candidate.id;
      const channel = candidate as ExportChannel;
      const directory = channel.name ?? dmDirectoryName(channel, users);
      if (!directory) continue;
      const conversation = { id, name: channel.name ?? directory, kind };
      channels.set(directory, conversation);
      // DM/MPIM export directories are sometimes the conversation id instead
      // of their generated display name.
      channels.set(id, conversation);
    }
  }
  return channels;
}

function dmDirectoryName(
  channel: ExportChannel,
  users: ReadonlyMap<string, ExportUser>,
): string | undefined {
  if (!channel.members || channel.members.length === 0) return undefined;
  return channel.members.map((id) => users.get(id)?.name ?? id).join(",");
}

function fallbackConversation(directory: string): SlackArchiveConversation {
  // A missing manifest must fail closed: the directory could be a private
  // channel or DM whose manifest was omitted from a partial export.
  return { id: directory, name: directory, kind: "private_channel" };
}

function parseMessageEntry(path: string): { path: string; directory: string } | null {
  const match = /^([^/]+)\/\d{4}-\d{2}-\d{2}\.json$/.exec(path);
  return match ? { path, directory: match[1]! } : null;
}

function userDisplayName(user: ExportUser | undefined): string | undefined {
  return user?.profile?.display_name || user?.profile?.real_name || user?.real_name || user?.name;
}

function actorKind(
  user: ExportUser | undefined,
  botId: string | null,
  subtype: string | undefined,
): SlackArchiveActorKind {
  if (user?.is_app_user) return "app";
  if (botId || user?.is_bot || subtype === "bot_message") return "bot";
  if (user) return "human";
  if (subtype) return "system";
  return "unknown";
}

function canonicalizeExportFile(file: NonNullable<ExportMessage["files"]>[number]): SlackArchiveFile {
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

function slackTsToMs(ts: string): number {
  const value = Number(ts);
  if (!Number.isFinite(value)) throw new Error(`Invalid Slack timestamp: ${ts}`);
  return Math.trunc(value * 1_000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function runUnzip(args: string[]): Promise<string> {
  const process = Bun.spawn(["unzip", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`unzip failed (${exitCode}): ${stderr.trim()}`);
  return stdout;
}
