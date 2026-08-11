import { existsSync, renameSync, statSync, unlinkSync } from "node:fs";
import { Index, MetricKind, ScalarKind } from "usearch";

export interface SlackArchiveVectorHit {
  rowid: number;
  cosine: number;
}

export interface SlackArchiveVectorSearcher {
  readonly size: number;
  search(query: Float32Array, limit: number): SlackArchiveVectorHit[];
}

export interface SlackArchiveMutableVectorIndex extends SlackArchiveVectorSearcher {
  upsert(record: SlackArchiveVectorRecord): void;
  remove(rowid: number): void;
}

export interface SlackArchiveVectorRecord {
  rowid: number;
  embedding: Float32Array;
}

const DEFAULT_CONNECTIVITY = 16;
const DEFAULT_EXPANSION_ADD = 128;
const DEFAULT_EXPANSION_SEARCH = 128;

/** Persisted HNSW index. SQLite rowids are the stable bridge back to metadata. */
export class SlackArchiveVectorIndex implements SlackArchiveVectorSearcher {
  private readonly index: Index;

  constructor(
    readonly dimensions: number,
    options: { path?: string; load?: boolean } = {},
  ) {
    this.index = new Index({
      dimensions,
      metric: MetricKind.Cos,
      quantization: ScalarKind.F32,
      connectivity: DEFAULT_CONNECTIVITY,
      expansion_add: DEFAULT_EXPANSION_ADD,
      expansion_search: DEFAULT_EXPANSION_SEARCH,
      multi: false,
    });
    if (options.load && options.path && existsSync(options.path)) {
      this.index.load(options.path);
    }
  }

  get size(): number {
    return this.index.size();
  }

  add(records: SlackArchiveVectorRecord[]): void {
    if (records.length === 0) return;
    const keys = new BigUint64Array(records.length);
    const vectors = new Float32Array(records.length * this.dimensions);
    records.forEach((record, index) => {
      if (!Number.isSafeInteger(record.rowid) || record.rowid < 1) {
        throw new Error(`Invalid Slack archive vector rowid: ${record.rowid}`);
      }
      if (record.embedding.length !== this.dimensions) {
        throw new Error(
          `Slack archive vector dimension mismatch: expected ${this.dimensions}, got ${record.embedding.length}`,
        );
      }
      keys[index] = BigInt(record.rowid);
      vectors.set(record.embedding, index * this.dimensions);
    });
    this.index.add(keys, vectors);
  }

  upsert(record: SlackArchiveVectorRecord): void {
    const key = BigInt(record.rowid);
    if (this.index.contains(key)) this.index.remove(key);
    this.add([record]);
  }

  remove(rowid: number): void {
    const key = BigInt(rowid);
    if (this.index.contains(key)) this.index.remove(key);
  }

  search(query: Float32Array, limit: number): SlackArchiveVectorHit[] {
    if (query.length !== this.dimensions || this.size === 0) return [];
    const count = Math.max(1, Math.min(this.size, Math.floor(limit)));
    const matches = this.index.search(query, count, 0);
    return Array.from(matches.keys, (key, index) => ({
      rowid: Number(key),
      // USearch cosine distance is 1 - cosine similarity.
      cosine: 1 - (matches.distances[index] ?? 1),
    }));
  }

  saveAtomically(path: string): void {
    const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
    try {
      this.index.save(temporaryPath);
      renameSync(temporaryPath, path);
    } finally {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    }
  }
}

/** Reloads a newly-published index without restarting the MCP server. */
export class ReloadingSlackArchiveVectorIndex implements SlackArchiveVectorSearcher {
  private loaded: SlackArchiveVectorIndex | null = null;
  private loadedMtimeMs = -1;

  constructor(
    private readonly path: string,
    private readonly dimensions: number,
  ) {}

  get size(): number {
    this.reloadIfChanged();
    return this.loaded?.size ?? 0;
  }

  search(query: Float32Array, limit: number): SlackArchiveVectorHit[] {
    this.reloadIfChanged();
    return this.loaded?.search(query, limit) ?? [];
  }

  private reloadIfChanged(): void {
    if (!existsSync(this.path)) {
      this.loaded = null;
      this.loadedMtimeMs = -1;
      return;
    }
    const mtimeMs = statSync(this.path).mtimeMs;
    if (this.loaded && mtimeMs === this.loadedMtimeMs) return;
    this.loaded = new SlackArchiveVectorIndex(this.dimensions, {
      path: this.path,
      load: true,
    });
    this.loadedMtimeMs = mtimeMs;
  }
}
