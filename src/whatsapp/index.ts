import type { WAMessage } from "baileys";
import { log } from "../logger.ts";
import { WhatsAppClient, type MessageSource } from "./client.ts";
import { createReadyGate, ingestMessages } from "./ingest.ts";
import { WhatsAppStore } from "./store.ts";
import type { WhatsAppConfig } from "./types.ts";

export { WhatsAppClient } from "./client.ts";
export { WhatsAppStore } from "./store.ts";
export { createReadyGate, ingestMessages, toWaMessage } from "./ingest.ts";
export type { ReadyGate } from "./ingest.ts";
export {
  createClaudeExtractionRunner,
  createExtractionSweep,
  runExtractionSweep,
  type ExtractionRunner,
  type ExtractionSweepDeps,
} from "./extraction/index.ts";
export type * from "./types.ts";

export interface WhatsAppHandle {
  /** The live message + task store — shared with the extraction sweep. */
  store: WhatsAppStore;
  /** Resolve a group JID to its current subject (from the socket's group map). */
  resolveGroupName: (groupJid: string) => string | undefined;
  stop(): Promise<void>;
}

/**
 * Start the WhatsApp ingestion subsystem: open the store, connect the Baileys
 * socket, and pipe backfill + live messages through `ingestMessages` into the
 * store (filtered to Hermes groups). Read-only — no send path.
 *
 * Backfill batches can arrive before the group-name map is populated, so every
 * batch flows through a `createReadyGate`: pre-open batches are buffered and
 * flushed in order once `onOpen` fires (group map ready), and later batches are
 * processed directly. On a reconnect the gate is re-closed via
 * `onConnectionClose` and reopened by the next `onOpen`, so batches arriving on
 * a fresh socket never process against a stale group map.
 *
 * Returns a handle exposing the store + group-name resolver (for the extraction
 * sweep) plus `stop()`, which ends the socket and closes the DB; wire it into
 * the process's graceful shutdown.
 */
export async function startWhatsApp(
  config: WhatsAppConfig,
): Promise<WhatsAppHandle> {
  const store = new WhatsAppStore(config.dbPath);
  const groupPattern = new RegExp(config.groupPattern, "i");

  // Assigned synchronously below; only read from callbacks that fire after
  // `connect()` returns, by which point the client exists.
  let client: WhatsAppClient | null = null;
  const resolveGroupName = (jid: string): string | undefined =>
    client?.getGroupName(jid);

  const processBatch = (batch: {
    messages: WAMessage[];
    source: MessageSource;
  }): void => {
    try {
      const persisted = ingestMessages(batch.messages, {
        store,
        groupPattern,
        resolveGroupName,
      });
      if (persisted > 0) {
        log.info(
          "whatsapp",
          `ingested ${persisted}/${batch.messages.length} ${batch.source} messages`,
        );
      }
    } catch (err) {
      log.error(
        "whatsapp",
        `ingest error (${batch.source}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const gate = createReadyGate(processBatch);

  client = new WhatsAppClient(config, {
    onQr: (qr) => {
      log.info(
        "whatsapp",
        `QR received — pair with \`bun run src/whatsapp/pair.ts\` to scan it (len=${qr.length})`,
      );
    },
    // Group map is populated by the time onOpen fires — release buffered backfill.
    onOpen: () => gate.open(),
    // Reconnect (or logout): re-gate until the next onOpen confirms a fresh map.
    onConnectionClose: () => gate.close(),
    onLoggedOut: () => {
      log.error("whatsapp", "Logged out — ingestion halted until re-paired.");
    },
    onMessages: (messages, source) => gate.push({ messages, source }),
  });

  await client.connect();

  return {
    store,
    resolveGroupName,
    async stop() {
      await client?.stop();
      store.close();
    },
  };
}
