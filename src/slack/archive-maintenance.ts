import { existsSync } from "node:fs";
import type { EmbeddingProvider } from "../memory/embedding/types.ts";
import { embedSlackArchive } from "./archive-embed.ts";
import { buildSlackArchiveVectorIndex } from "./archive-index.ts";
import { SlackArchiveStore } from "./archive-store.ts";
import { syncSlackArchive, type SlackArchiveClient } from "./archive-sync.ts";

export interface SlackArchiveMaintenanceOptions {
  client: SlackArchiveClient;
  dbPath: string;
  approvedChannelIds?: ReadonlySet<string>;
  embedder?: EmbeddingProvider;
  indexPath?: string;
  dimensions?: number;
  embedBatchSize?: number;
  indexBatchSize?: number;
}

export interface SlackArchiveMaintenanceReport {
  channelsSynced: number;
  messagesSeen: number;
  embedded: number;
  staleSkipped: number;
  remaining: number;
  indexed: number;
  indexRebuilt: boolean;
  dbPath: string;
  indexPath: string;
}

/**
 * Weekly, native archive maintenance. Slack API history closes gaps left by
 * event delivery; embeddings and the separately persisted ANN index then move
 * forward as one deployment unit.
 */
export async function runSlackArchiveMaintenance(
  options: SlackArchiveMaintenanceOptions,
): Promise<SlackArchiveMaintenanceReport> {
  const dimensions = options.dimensions ?? 640;
  const indexPath = options.indexPath ?? `${options.dbPath}.usearch`;
  const store = new SlackArchiveStore(options.dbPath, { vectorDimensions: dimensions });
  try {
    const synced = await syncSlackArchive({
      client: options.client,
      store,
      approvedChannelIds: options.approvedChannelIds,
    });
    const embedder = options.embedder ?? (await loadLocalEmbedder());
    const embeddings = await embedSlackArchive({
      store,
      provider: embedder,
      dryRun: false,
      batchSize: options.embedBatchSize ?? 100,
    });

    // The corpus revision changes for both vector additions and removals. The
    // indexed revision is recorded only after atomic sidecar publication, so a
    // crash or concurrent write safely leaves another rebuild pending.
    const corpusRevision = store.getEmbeddingCorpusRevision();
    const indexedRevision = store.getEmbeddingIndexRevision(dimensions);
    const shouldRebuildIndex = corpusRevision !== indexedRevision || !existsSync(indexPath);
    const indexed = shouldRebuildIndex
      ? buildSlackArchiveVectorIndex({
          store,
          indexPath,
          dimensions,
          batchSize: options.indexBatchSize ?? 1_000,
        }).indexed
      : store.countEmbeddedMessages(dimensions);
    if (shouldRebuildIndex) store.setEmbeddingIndexRevision(dimensions, corpusRevision);

    return {
      channelsSynced: synced.channels,
      messagesSeen: synced.messages,
      embedded: embeddings.embedded,
      staleSkipped: embeddings.staleSkipped,
      remaining: embeddings.remaining,
      indexed,
      indexRebuilt: shouldRebuildIndex,
      dbPath: options.dbPath,
      indexPath,
    };
  } finally {
    store.close();
  }
}

export function formatSlackArchiveMaintenance(
  report: SlackArchiveMaintenanceReport,
): string {
  return [
    "Slack archive maintenance complete.",
    `- channels synced: ${report.channelsSynced}`,
    `- messages observed: ${report.messagesSeen}`,
    `- messages embedded: ${report.embedded}`,
    `- stale embedding writes skipped: ${report.staleSkipped}`,
    `- embeddings remaining: ${report.remaining}`,
    `- ANN vectors: ${report.indexed}`,
    `- ANN index rebuilt: ${report.indexRebuilt ? "yes" : "no (corpus unchanged)"}`,
    `- database: ${report.dbPath}`,
    `- index: ${report.indexPath}`,
  ].join("\n");
}

async function loadLocalEmbedder(): Promise<EmbeddingProvider> {
  const { createEmbeddingProvider } = await import("../memory/embedding/factory.ts");
  return createEmbeddingProvider("local");
}
