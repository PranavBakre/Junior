export type SlackArchiveActorKind = "human" | "bot" | "app" | "system" | "unknown";

export type SlackArchiveIngestSource = "live" | "backfill";

export interface SlackArchiveFile {
  id: string;
  name: string | null;
  title: string | null;
  mimetype: string | null;
  filetype: string | null;
  size: number | null;
  urlPrivate: string | null;
  permalink: string | null;
}

export interface SlackArchiveConversation {
  id: string;
  name: string | null;
  kind: "public_channel" | "private_channel" | "im" | "mpim";
}

/** A passive, verbatim Slack archive row. This is deliberately not a memory claim. */
export interface SlackArchiveMessageInput {
  channelId: string;
  ts: string;
  /** Slack's thread_ts. Root messages may omit it; the store canonicalises it to ts. */
  threadTs?: string | null;
  channelName?: string | null;
  actorId?: string | null;
  userId?: string | null;
  botId?: string | null;
  actorName?: string | null;
  actorKind?: SlackArchiveActorKind | null;
  text: string;
  files?: SlackArchiveFile[];
  subtype?: string | null;
  permalink?: string | null;
  metadata?: Record<string, unknown> | null;
  /** Optional forensic payload. Importers leave this null to avoid duplicating large exports. */
  rawJson?: Record<string, unknown> | null;
  embedding?: Float32Array | null;
  embedModel?: string | null;
  /** Defaults to embedding.length when an embedding is supplied. */
  dim?: number | null;
  ingestSource?: SlackArchiveIngestSource;
  /** When this version was observed. Newer observations win over stale backfill. */
  observedAt?: number;
  /** Event time used by filters; derived from Slack ts when omitted. */
  eventTimeMs?: number;
}

export interface SlackArchiveMessage {
  channelId: string;
  channelName: string | null;
  ts: string;
  threadTs: string;
  actorId: string | null;
  userId: string | null;
  botId: string | null;
  actorName: string | null;
  actorKind: SlackArchiveActorKind | null;
  text: string;
  files: SlackArchiveFile[];
  subtype: string | null;
  permalink: string | null;
  metadata: Record<string, unknown> | null;
  rawJson: Record<string, unknown> | null;
  embedding: Float32Array | null;
  embedModel: string | null;
  dim: number | null;
  ingestSource: SlackArchiveIngestSource;
  observedAt: number;
  eventTimeMs: number;
}

export interface SlackArchiveFilters {
  channelId?: string;
  /** Server-authorized channel scope for archive-wide searches. */
  channelIds?: string[];
  actorId?: string;
  actorKind?: SlackArchiveActorKind;
  sinceMs?: number;
  untilMs?: number;
}

export interface SlackArchiveSearchOptions {
  queryText?: string;
  /** Precomputed at the caller boundary; this store never loads an embedder. */
  queryVector?: Float32Array;
  filters?: SlackArchiveFilters;
  limit?: number;
  /** Attach bounded chronological thread context to every hit. */
  expandThreads?: boolean;
  threadLimit?: number;
}

export interface SlackArchiveSearchResult {
  message: SlackArchiveMessage;
  score: number;
  cosine: number | null;
  lexicalRank: number | null;
  vectorRank: number | null;
  thread: SlackArchiveMessage[] | null;
}

export interface SlackArchiveCheckpointInput {
  scope: string;
  cursor: string;
  updatedAt?: number;
  metadata?: Record<string, unknown> | null;
}

export interface SlackArchiveCheckpoint {
  scope: string;
  cursor: string;
  updatedAt: number;
  metadata: Record<string, unknown> | null;
}

export type SlackArchiveWriteResult = "inserted" | "updated" | "deduped";
