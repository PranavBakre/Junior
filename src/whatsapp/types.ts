/**
 * WhatsApp ingestion types — read-only message archive.
 *
 * The subsystem ingests group messages into SQLite and exposes them through
 * the bot MCP server's read/search tools. No sending/reply surface exists.
 */

/** A raw group message persisted to the append-only `wa_messages` table. */
export interface WaMessage {
  /** WhatsApp message id (`key.id`). Primary key — dedupes backfill vs live. */
  id: string;
  /** Group JID (`<id>@g.us`). */
  groupJid: string;
  /** Group subject at ingestion time, if known. */
  groupName: string | null;
  /** Sender JID (`key.participant` in a group). */
  senderJid: string;
  /** Sender display name (`pushName`), if present. */
  senderName: string | null;
  /** Message timestamp in seconds (WhatsApp `messageTimestamp`). */
  ts: number;
  /** Extracted text or caption. Never persisted null (messages without text are skipped). */
  text: string | null;
  /** `contextInfo.stanzaId` of the quoted message, if this is a reply. */
  replyToId: string | null;
  /** JSON of the raw Baileys message event, for later re-processing. */
  raw: string | null;
}

/** Input to `upsertMessage`. */
export type WaMessageInput = WaMessage;

/** One group's summary row for the `whatsapp_list_groups` tool. */
export interface WaGroupSummary {
  groupJid: string;
  /** Most recent non-null subject seen for the group. */
  groupName: string | null;
  messageCount: number;
  /** Timestamps (seconds) of the oldest and newest stored messages. */
  firstTs: number;
  lastTs: number;
}

/** Filters for `getMessages` — reads the newest matching window. */
export interface WaMessageQuery {
  groupJid?: string;
  /** Only messages strictly older than this timestamp (seconds). */
  beforeTs?: number;
  /**
   * Tie-breaker for `beforeTs`: also return messages AT `beforeTs` whose id
   * sorts below this one. WhatsApp timestamps are whole seconds, so a page
   * boundary can split a same-second run; paging on (ts, id) together keeps
   * every message reachable.
   */
  beforeId?: string;
  /** Only messages at or after this timestamp (seconds). */
  afterTs?: number;
  limit: number;
}

/** Filters for `searchMessages` — case-insensitive substring match on text. */
export interface WaSearchQuery {
  query: string;
  groupJid?: string;
  /** Case-insensitive substring match on sender name or JID. */
  sender?: string;
  limit: number;
}

/** Resolved WhatsApp subsystem config (mirrors `Config["whatsapp"]`). */
export interface WhatsAppConfig {
  /** Master switch — the subsystem only starts when true. */
  enabled: boolean;
  /** SQLite path for the message store. */
  dbPath: string;
  /** Directory for Baileys multi-file auth state (creds + signal keys). */
  authDir: string;
  /**
   * Case-insensitive regex source matched against group subjects. Null means
   * no filter — ingest every group the account is in.
   */
  groupPattern: string | null;
}
