import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { SlackArchiveStore } from "./archive-store.ts";
import { SlackArchiveVectorIndex } from "./archive-vector-index.ts";

export interface SlackArchiveIndexBuildReport {
  dimensions: number;
  indexed: number;
  indexPath: string;
  elapsedMs: number;
}

export function buildSlackArchiveVectorIndex(options: {
  store: Pick<SlackArchiveStore, "countEmbeddedMessages" | "getEmbeddedVectorRecords">;
  indexPath: string;
  dimensions: number;
  batchSize?: number;
  onProgress?: (indexed: number, total: number) => void;
}): SlackArchiveIndexBuildReport {
  const startedAt = performance.now();
  const batchSize = Math.max(1, Math.min(10_000, Math.floor(options.batchSize ?? 1_000)));
  const total = options.store.countEmbeddedMessages(options.dimensions);
  const index = new SlackArchiveVectorIndex(options.dimensions);
  let afterRowid = 0;
  let indexed = 0;
  while (true) {
    const records = options.store.getEmbeddedVectorRecords(
      afterRowid,
      batchSize,
      options.dimensions,
    );
    if (records.length === 0) break;
    index.add(records);
    afterRowid = records.at(-1)!.rowid;
    indexed += records.length;
    options.onProgress?.(indexed, total);
  }
  mkdirSync(dirname(options.indexPath), { recursive: true });
  index.saveAtomically(options.indexPath);
  return {
    dimensions: options.dimensions,
    indexed,
    indexPath: options.indexPath,
    elapsedMs: performance.now() - startedAt,
  };
}

