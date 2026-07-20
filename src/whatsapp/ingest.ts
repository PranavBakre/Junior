import type { WAMessage, proto } from "baileys";
import type { WaMessageInput } from "./types.ts";

/** Minimal store surface ingestion needs — keeps `ingestMessages` easy to unit test. */
export interface IngestStore {
  upsertMessage(msg: WaMessageInput): void;
}

export interface IngestDeps {
  store: IngestStore;
  /** Compiled from `config.groupPattern`, case-insensitive. Null = no filter (all groups). */
  groupPattern: RegExp | null;
  /** Resolve a group JID to its current subject. Undefined when the group is unknown. */
  resolveGroupName: (groupJid: string) => string | undefined;
}

/**
 * Pure event→store glue. Persists group messages that carry text or a caption;
 * when `groupPattern` is set, only groups whose resolved subject matches it.
 * Everything else (DMs, non-matching groups, unknown groups, empty system
 * messages) is silently skipped.
 *
 * Returns the number of messages actually handed to `upsertMessage` (dedup
 * happens at the store layer via INSERT OR IGNORE).
 */
export function ingestMessages(
  messages: WAMessage[],
  deps: IngestDeps,
): number {
  let persisted = 0;
  for (const message of messages) {
    const record = toWaMessage(message, deps);
    if (record) {
      deps.store.upsertMessage(record);
      persisted += 1;
    }
  }
  return persisted;
}

/**
 * Convert one Baileys message into a store record, or null if it should be
 * skipped. Exported for direct unit testing of the filtering rules.
 */
export function toWaMessage(
  message: WAMessage,
  deps: IngestDeps,
): WaMessageInput | null {
  const key = message.key;
  const id = key?.id;
  const groupJid = key?.remoteJid ?? undefined;
  if (!id || !groupJid) return null;

  // Groups only. DMs (`@s.whatsapp.net`) and broadcasts are out of scope.
  if (!groupJid.endsWith("@g.us")) return null;

  const groupName = deps.resolveGroupName(groupJid);
  // Without a subject we can't apply the group filter — skip rather than risk
  // persisting groups the pattern was meant to exclude.
  if (groupName === undefined) return null;
  if (deps.groupPattern && !deps.groupPattern.test(groupName)) return null;

  const content = unwrap(message.message ?? undefined);
  const text = extractText(content);
  if (!text) return null; // skip messages with no text/caption entirely

  const senderJid = key.participant ?? groupJid;
  const contextInfo = getContextInfo(content);

  return {
    id,
    groupJid,
    groupName,
    senderJid,
    senderName: message.pushName ?? null,
    ts: toSeconds(message.messageTimestamp),
    text,
    replyToId: contextInfo?.stanzaId ?? null,
    raw: safeStringify(message),
  };
}

/**
 * Peel wrapper messages (ephemeral / view-once / document-with-caption) to
 * reach the real content. Returns the innermost content, or undefined.
 */
function unwrap(
  content: proto.IMessage | undefined,
): proto.IMessage | undefined {
  if (!content) return undefined;
  const inner =
    content.ephemeralMessage?.message ??
    content.viewOnceMessage?.message ??
    content.viewOnceMessageV2?.message ??
    content.viewOnceMessageV2Extension?.message ??
    content.documentWithCaptionMessage?.message;
  return inner ? unwrap(inner) : content;
}

function extractText(content: proto.IMessage | undefined): string | null {
  if (!content) return null;
  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    null
  );
}

function getContextInfo(
  content: proto.IMessage | undefined,
): proto.IContextInfo | null | undefined {
  if (!content) return undefined;
  return (
    content.extendedTextMessage?.contextInfo ??
    content.imageMessage?.contextInfo ??
    content.videoMessage?.contextInfo ??
    content.documentMessage?.contextInfo
  );
}

/** WhatsApp timestamps are seconds, delivered as number or Long. Normalize to number. */
function toSeconds(
  ts: WAMessage["messageTimestamp"],
): number {
  if (ts == null) return Math.floor(Date.now() / 1000);
  if (typeof ts === "number") return ts;
  // Long-like: has toNumber().
  return typeof ts.toNumber === "function" ? ts.toNumber() : Number(ts);
}

function safeStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
  } catch {
    return null;
  }
}

/**
 * A one-shot readiness gate around batch processing.
 *
 * Baileys can deliver `messaging-history.set` backfill batches BEFORE the
 * socket's `connection: open` handler has populated the group-subject map —
 * and `toWaMessage` silently drops messages from unknown groups (it can't
 * confirm they're Hermes groups without a subject). That races the backfill
 * into the void.
 *
 * The gate buffers every batch pushed before `open()` and flushes them, in
 * arrival order, the moment the group map is ready. After `open()`, batches are
 * processed synchronously with no buffering. `open()` is idempotent while open,
 * so reconnects that re-fire `connection: open` without a preceding close never
 * replay or re-flush.
 *
 * `close()` reverses `open()`: subsequent pushes buffer again until the next
 * `open()`. This matters on reconnect — the socket can re-open and start
 * delivering batches (joined/renamed groups included) BEFORE the group-subject
 * map has been refreshed, and processing them against a stale map would drop or
 * mis-label those messages. Wiring `connection: close → close()` and the
 * map-confirmed `open → open()` makes each close→open cycle re-buffer and then
 * flush in order once the map is ready again.
 */
export interface ReadyGate<T> {
  /** Queue a batch (while closed) or process it immediately (while open). */
  push(batch: T): void;
  /** Mark ready: flush queued batches in arrival order, then pass through. Idempotent while open. */
  open(): void;
  /** Reverse `open()`: buffer subsequent pushes until the next `open()`. Idempotent while closed. */
  close(): void;
}

export function createReadyGate<T>(process: (batch: T) => void): ReadyGate<T> {
  let opened = false;
  const queue: T[] = [];
  return {
    push(batch: T): void {
      if (opened) {
        process(batch);
        return;
      }
      queue.push(batch);
    },
    open(): void {
      if (opened) return;
      opened = true;
      // Snapshot-and-clear before draining so a re-entrant push() triggered
      // synchronously from within process() is handled directly (post-open),
      // never re-queued or double-flushed.
      const pending = queue.splice(0, queue.length);
      for (const batch of pending) process(batch);
    },
    close(): void {
      opened = false;
    },
  };
}
