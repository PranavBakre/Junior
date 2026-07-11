/**
 * WhatsApp ingestion types (Phase 0+1: read-only ingestion + pairing).
 *
 * No sending/reply surface exists in this phase — these types cover the raw
 * message store and the task table the extraction pipeline (Phase 2) will fill.
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
  /** Whether the extraction sweep has consumed this message. */
  processed: boolean;
}

/** Input to `upsertMessage` — `processed` defaults to false. */
export type WaMessageInput = Omit<WaMessage, "processed">;

export type WaTaskPriority = "p0" | "p1" | "p2";
export type WaTaskStatus = "open" | "in-progress" | "done" | "blocked";

/** A task inferred from group messages, synced to Notion in Phase 2. */
export interface WaTask {
  id: string;
  task: string;
  owner: string | null;
  priority: WaTaskPriority | null;
  status: WaTaskStatus;
  notes: string | null;
  /** Group the task originated from. */
  groupJid: string | null;
  /** `wa_messages.id` the task was extracted from. */
  sourceMsgId: string | null;
  /** Notion page id for the synced row, once created. */
  notionPageId: string | null;
  /**
   * Whether the row has local changes not yet reflected in Notion. Set on
   * create/update, cleared on a successful Notion sync. Drives the sweep's retry
   * of rows whose Notion write failed transiently.
   */
  notionDirty: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Input to `createTask`. `id` is generated when omitted; `status` defaults to "open". */
export interface CreateWaTaskInput {
  id?: string;
  task: string;
  owner?: string | null;
  priority?: WaTaskPriority | null;
  status?: WaTaskStatus;
  notes?: string | null;
  groupJid?: string | null;
  sourceMsgId?: string | null;
}

/** Partial patch for `updateTask`. Only provided fields are written; `updatedAt` always bumps. */
export interface UpdateWaTaskInput {
  task?: string;
  owner?: string | null;
  priority?: WaTaskPriority | null;
  status?: WaTaskStatus;
  notes?: string | null;
}

/** Resolved WhatsApp subsystem config (mirrors `Config["whatsapp"]`). */
export interface WhatsAppConfig {
  /** Master switch — the subsystem only starts when true. */
  enabled: boolean;
  /** SQLite path for the message + task store. */
  dbPath: string;
  /** Directory for Baileys multi-file auth state (creds + signal keys). */
  authDir: string;
  /** Case-insensitive regex source matched against group subjects. */
  groupPattern: string;
  /** Extraction sweep cadence in ms (`WHATSAPP_EXTRACTION_INTERVAL_MS`). */
  extractionIntervalMs: number;
  /** Notion integration token; null disables Notion sync (extraction still runs). */
  notionToken: string | null;
  /** Notion page id the Hermes tasks database lives under. */
  notionPageId: string;
}
