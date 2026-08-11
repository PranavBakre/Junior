import { LocalEmbeddingProvider } from "../memory/embedding/local.ts";
import type { EmbeddingProvider } from "../memory/embedding/types.ts";
import type {
  SlackArchiveEmbeddingCandidate,
  SlackArchiveEmbeddingUpdate,
} from "./archive-store.ts";

export interface SlackArchiveEmbeddingStore {
  countMessagesPendingEmbedding(): { pending: number; emptyText: number };
  getMessagesPendingEmbedding(limit: number): SlackArchiveEmbeddingCandidate[];
  updateMessageEmbeddings(updates: SlackArchiveEmbeddingUpdate[]): number;
}

export interface SlackArchiveEmbedProgress {
  batch: number;
  attempted: number;
  embedded: number;
  staleSkipped: number;
  remaining: number;
}

export interface SlackArchiveEmbedOptions {
  store: SlackArchiveEmbeddingStore;
  provider?: EmbeddingProvider;
  dryRun?: boolean;
  batchSize?: number;
  /** Test/operational escape hatch; omitted means process all pending rows. */
  maxBatches?: number;
  onProgress?: (progress: SlackArchiveEmbedProgress) => void;
}

export interface SlackArchiveEmbedReport {
  dryRun: boolean;
  model: string | null;
  dim: number | null;
  initialPending: number;
  emptyTextSkipped: number;
  batches: number;
  attempted: number;
  embedded: number;
  staleSkipped: number;
  remaining: number;
}

/**
 * Embeds only currently-unembedded, non-empty messages. Each batch is committed
 * independently; a rerun naturally resumes from the remaining NULL rows.
 */
export async function embedSlackArchive(
  options: SlackArchiveEmbedOptions,
): Promise<SlackArchiveEmbedReport> {
  const dryRun = options.dryRun ?? true;
  const batchSize = boundedBatchSize(options.batchSize);
  const initial = options.store.countMessagesPendingEmbedding();
  const report: SlackArchiveEmbedReport = {
    dryRun,
    model: null,
    dim: null,
    initialPending: initial.pending,
    emptyTextSkipped: initial.emptyText,
    batches: 0,
    attempted: 0,
    embedded: 0,
    staleSkipped: 0,
    remaining: initial.pending,
  };
  if (dryRun || initial.pending === 0) return report;

  const provider = options.provider ?? new LocalEmbeddingProvider();
  report.model = provider.model;
  report.dim = provider.dim;
  const maxBatches = options.maxBatches === undefined
    ? Number.POSITIVE_INFINITY
    : Math.max(0, Math.floor(options.maxBatches));

  while (report.batches < maxBatches) {
    const candidates = options.store.getMessagesPendingEmbedding(batchSize);
    if (candidates.length === 0) break;
    const vectors = await provider.embed(candidates.map((candidate) => candidate.text), "document");
    if (vectors.length !== candidates.length) {
      throw new Error(
        `Embedding provider returned ${vectors.length} vectors for ${candidates.length} Slack messages`,
      );
    }
    const updates = candidates.map((candidate, index): SlackArchiveEmbeddingUpdate => {
      const embedding = vectors[index];
      if (!embedding || embedding.length !== provider.dim) {
        throw new Error(
          `Embedding provider returned invalid vector dimension for Slack message metadata at batch index ${index}`,
        );
      }
      return {
        ...candidate,
        embedding,
        embedModel: provider.model,
        dim: provider.dim,
      };
    });
    const embedded = options.store.updateMessageEmbeddings(updates);
    report.batches += 1;
    report.attempted += candidates.length;
    report.embedded += embedded;
    report.staleSkipped += candidates.length - embedded;
    // Avoid a full-table COUNT after every batch. A stale update remains
    // pending and will be selected again with its current text; successful
    // updates are the only rows that leave the pending set.
    report.remaining = Math.max(0, report.remaining - embedded);
    options.onProgress?.({
      batch: report.batches,
      attempted: report.attempted,
      embedded: report.embedded,
      staleSkipped: report.staleSkipped,
      remaining: report.remaining,
    });
  }
  report.remaining = options.store.countMessagesPendingEmbedding().pending;
  return report;
}

function boundedBatchSize(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isFinite(value)) return 100;
  return Math.max(1, Math.min(10_000, Math.floor(value)));
}
