import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { MemoryStore } from "./store.ts";
import type {
  ArchiveStaleClaimsOptions,
  ArchiveStaleClaimsResult,
  ClaimInput,
  ClaimKind,
  ClaimRecallOptions,
  ClaimRecallResult,
  ClaimVectorExport,
  EpisodeInput,
  MemoryHealth,
  MemoryHealthKind,
  MemoryHealthOptions,
  MemoryFactInput,
  MemoryLessonInput,
  MemorySourceRecord,
  SearchableMemoryKind,
  UnconsolidatedSourceRecordOptions,
} from "./types.ts";

type ClaimRow = {
  id: string;
  kind: string;
  text: string;
  embedding: Uint8Array | null;
  embed_model: string | null;
  dim: number | null;
  repo: string | null;
  tags: string | null;
  source_episode: string | null;
  helpful_count: number | null;
  unhelpful_count: number | null;
  weight: number | null;
  created_at: number;
  last_used_at: number | null;
  active: number | null;
};

type SourceRecordRow = {
  id: string;
  kind: string;
  channel_id: string | null;
  thread_id: string | null;
  slack_ts: string | null;
  source_url: string | null;
  actor_id: string | null;
  actor_kind: string | null;
  agent_name: string | null;
  repo_name: string | null;
  body: string;
  metadata_json: string | null;
  created_at: number;
};

export class SqliteMemoryStore implements MemoryStore {
  private db: Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  async appendSourceRecord(record: MemorySourceRecord): Promise<void> {
    this.db
      .query(
        `INSERT OR IGNORE INTO memory_source_record (
          id, kind, channel_id, thread_id, slack_ts, source_url, actor_id,
          actor_kind, agent_name, repo_name, body, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.kind,
        record.channelId ?? null,
        record.threadId ?? null,
        record.slackTs ?? null,
        record.sourceUrl ?? null,
        record.actorId ?? null,
        record.actorKind ?? null,
        record.agentName ?? null,
        record.repoName ?? null,
        record.body,
        record.metadata ? JSON.stringify(record.metadata) : null,
        record.createdAt,
      );
  }

  async upsertLesson(lesson: MemoryLessonInput): Promise<void> {
    const importance = lesson.importance ?? 0.5;
    const txn = this.db.transaction(() => {
      this.upsertNode(lesson.id, "lesson", lesson.createdAt);
      this.db
        .query(
          `INSERT INTO lesson (id, title, body, applies_when, importance, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title,
             body = excluded.body,
             applies_when = excluded.applies_when,
             importance = excluded.importance`,
        )
        .run(
          lesson.id,
          lesson.title,
          lesson.body,
          lesson.appliesWhen ?? null,
          importance,
          lesson.createdAt,
        );
      this.replaceProvenance(lesson.id, lesson.sourceIds ?? []);
      this.replaceTags(lesson.id, "lesson", lesson.tags ?? []);
    });
    txn();
  }

  async upsertFact(fact: MemoryFactInput): Promise<void> {
    const importance = fact.importance ?? 0.5;
    const confidence = fact.confidence ?? 0.5;
    const nodeKind: SearchableMemoryKind =
      fact.kind === "curated_fact" ? "fact" : fact.kind;
    const txn = this.db.transaction(() => {
      this.upsertNode(fact.id, nodeKind, fact.createdAt);
      this.db
        .query(
          `INSERT INTO memory_fact (id, kind, title, body, confidence, importance, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             kind = excluded.kind,
             title = excluded.title,
             body = excluded.body,
             confidence = excluded.confidence,
             importance = excluded.importance`,
        )
        .run(
          fact.id,
          fact.kind,
          fact.title ?? null,
          fact.body,
          confidence,
          importance,
          fact.createdAt,
        );
      this.replaceProvenance(fact.id, fact.sourceIds ?? []);
      this.replaceTags(fact.id, nodeKind, fact.tags ?? []);
    });
    txn();
  }

  // --- memory v3: claims (semantic, embedded) -------------------------------

  async upsertClaim(claim: ClaimInput): Promise<void> {
    const tags = unique((claim.tags ?? []).map(normalizeName));
    const dim = claim.dim ?? (claim.embedding ? claim.embedding.length : null);
    const txn = this.db.transaction(() => {
      this.upsertNode(claim.id, "claim", claim.createdAt);
      this.db
        .query(
          `INSERT INTO claim (
            id, kind, text, embedding, embed_model, dim, repo, tags, source_episode,
            helpful_count, unhelpful_count, weight, created_at, last_used_at, active
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            kind = excluded.kind,
            text = excluded.text,
            embedding = excluded.embedding,
            embed_model = excluded.embed_model,
            dim = excluded.dim,
            repo = excluded.repo,
            tags = excluded.tags,
            source_episode = excluded.source_episode,
            helpful_count = excluded.helpful_count,
            unhelpful_count = excluded.unhelpful_count,
            weight = excluded.weight,
            last_used_at = excluded.last_used_at,
            active = excluded.active`,
        )
        .run(
          claim.id,
          claim.kind,
          claim.text,
          claim.embedding ? serializeEmbedding(claim.embedding) : null,
          claim.embedModel ?? null,
          dim,
          claim.repo ?? null,
          tags.length ? JSON.stringify(tags) : null,
          claim.sourceEpisode ?? null,
          claim.helpfulCount ?? 0,
          claim.unhelpfulCount ?? 0,
          claim.weight ?? 1.0,
          claim.createdAt,
          claim.lastUsedAt ?? null,
          claim.active === false ? 0 : 1,
        );
    });
    txn();
  }

  /**
   * BRUTE-FORCE COSINE recall over the claim corpus (rung 1 of the vector
   * ladder). Filters are the WHERE (they narrow candidates FIRST) and the cosine
   * against a PRE-COMPUTED queryVector is the ORDER BY. This method never embeds —
   * the caller embeds at the boundary. With no queryVector it ranks by `weight`.
   */
  async recallClaims(options: ClaimRecallOptions): Promise<ClaimRecallResult[]> {
    const limit = options.limit ?? 5;
    const filters = options.filters ?? {};
    const queryVector = options.queryVector;

    // 1. SQL WHERE pre-filter — narrow candidates BEFORE any cosine.
    const where: string[] = ["active = 1"];
    const params: (string | number)[] = [];
    if (filters.repo) {
      where.push("repo = ?");
      params.push(filters.repo);
    }
    if (filters.kind) {
      where.push("kind = ?");
      params.push(filters.kind);
    }
    if (filters.sinceMs != null) {
      where.push("created_at >= ?");
      params.push(filters.sinceMs);
    }
    if (filters.tags && filters.tags.length) {
      const normTags = unique(filters.tags.map(normalizeName));
      const clauses = normTags.map(
        () => "EXISTS (SELECT 1 FROM json_each(claim.tags) WHERE value = ?)",
      );
      where.push(`(${clauses.join(" OR ")})`);
      params.push(...normTags);
    }
    const rows = this.db
      .query<ClaimRow, (string | number)[]>(
        `SELECT id, kind, text, embedding, embed_model, dim, repo, tags, source_episode,
                helpful_count, unhelpful_count, weight, created_at, last_used_at, active
         FROM claim WHERE ${where.join(" AND ")}`,
      )
      .all(...params);

    // 2. Cosine in TS, weighted by `weight`. With no queryVector, the cosine is
    //    null and rows rank by `weight` alone.
    const scored = rows.map((row) => {
      const tags = row.tags ? (JSON.parse(row.tags) as string[]) : [];
      const weight = row.weight ?? 1;
      const vec = deserializeEmbedding(row.embedding);
      const cosine = queryVector && vec ? cosineSim(queryVector, vec) : null;
      const base = queryVector ? (cosine ?? 0) : 1;
      return { row, tags, weight, cosine, score: base * weight };
    });

    scored.sort((a, b) => b.score - a.score);
    const results = scored.slice(0, limit).map((entry) => ({
      id: entry.row.id,
      kind: entry.row.kind as ClaimKind,
      text: entry.row.text,
      repo: entry.row.repo,
      tags: entry.tags,
      weight: entry.weight,
      score: entry.score,
      cosine: entry.cosine,
      sourceEpisode: entry.row.source_episode,
      helpfulCount: entry.row.helpful_count ?? 0,
      unhelpfulCount: entry.row.unhelpful_count ?? 0,
      createdAt: entry.row.created_at,
      lastUsedAt: entry.row.last_used_at,
    }));

    // Usage bump — the genuine-production-recall signal that drives decay.
    // Gated by recordUsage (default true); eval/dashboard reads pass false so
    // inspection traffic never pollutes the fade signal (§7.1).
    if (options.recordUsage !== false && results.length > 0) {
      const now = Date.now();
      const bump = this.db.query("UPDATE claim SET last_used_at = ? WHERE id = ?");
      const txn = this.db.transaction(() => {
        for (const result of results) bump.run(now, result.id);
      });
      txn();
    }

    return results;
  }

  /**
   * Export every ACTIVE claim that carries an embedding, with the Float32 LE
   * BLOB deserialized to a Float32Array (reusing the same `deserializeEmbedding`
   * helper the cosine recall path uses). Read-only; claims with no embedding are
   * skipped. Intended for the dashboard's 2D projection view, not the hot path.
   */
  async exportClaimVectors(): Promise<ClaimVectorExport[]> {
    const rows = this.db
      .query<ClaimRow, []>(
        `SELECT id, kind, text, embedding, embed_model, dim, repo, tags, source_episode,
                helpful_count, unhelpful_count, weight, created_at, last_used_at, active
         FROM claim WHERE active = 1`,
      )
      .all();
    const out: ClaimVectorExport[] = [];
    for (const row of rows) {
      const vector = deserializeEmbedding(row.embedding);
      if (!vector) continue;
      out.push({
        id: row.id,
        kind: row.kind as ClaimKind,
        text: row.text,
        repo: row.repo,
        tags: row.tags ? (JSON.parse(row.tags) as string[]) : [],
        vector,
      });
    }
    return out;
  }

  // --- memory v3: episodes (raw affect log) ---------------------------------

  async appendEpisode(episode: EpisodeInput): Promise<void> {
    const txn = this.db.transaction(() => {
      // The episode extends a backing source record (provenance/evidence).
      this.db
        .query(
          `INSERT OR IGNORE INTO memory_source_record (
            id, kind, channel_id, thread_id, slack_ts, source_url, actor_id,
            actor_kind, agent_name, repo_name, body, metadata_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          episode.id,
          episode.sourceKind ?? "slack_message",
          episode.channelId ?? null,
          episode.threadId ?? null,
          episode.slackTs ?? null,
          episode.sourceUrl ?? null,
          episode.actorId ?? null,
          episode.actorKind ?? null,
          episode.agentName ?? null,
          episode.repoName ?? null,
          episode.what,
          episode.metadata ? JSON.stringify(episode.metadata) : null,
          episode.createdAt,
        );
      this.db
        .query(
          `INSERT INTO episode (
            id, actor, subjects_json, what, emotion, intensity, valence,
            trigger, response, salience, consolidated_into_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            actor = excluded.actor,
            subjects_json = excluded.subjects_json,
            what = excluded.what,
            emotion = excluded.emotion,
            intensity = excluded.intensity,
            valence = excluded.valence,
            trigger = excluded.trigger,
            response = excluded.response,
            salience = excluded.salience,
            consolidated_into_json = excluded.consolidated_into_json`,
        )
        .run(
          episode.id,
          episode.actor ?? null,
          episode.subjects ? JSON.stringify(episode.subjects) : null,
          episode.what,
          episode.emotion ?? null,
          episode.intensity ?? null,
          episode.valence ?? null,
          episode.trigger ?? null,
          episode.response ?? null,
          episode.salience ?? null,
          episode.consolidatedInto ? JSON.stringify(episode.consolidatedInto) : null,
          episode.createdAt,
        );
    });
    txn();
  }

  /**
   * Bump `last_used_at` on the given episodes — the consolidation pass's record
   * that it read them (their last contribution to a derivation). Not recordUsage-
   * gated at this layer: only the genuine consolidation reader calls it.
   */
  async markEpisodesUsed(ids: string[], now: number): Promise<void> {
    const uniqueIds = unique(ids);
    if (uniqueIds.length === 0) return;
    const bump = this.db.query("UPDATE episode SET last_used_at = ? WHERE id = ?");
    const txn = this.db.transaction(() => {
      for (const id of uniqueIds) bump.run(now, id);
    });
    txn();
  }

  // --- memory v3: consolidation source-record bookkeeping -------------------

  /**
   * Raw source records the consolidation engine has not yet processed
   * (`consolidated_at IS NULL`), oldest first. Scoped to one thread when
   * `threadId` is given; capped by `limit`. The offline consolidation pass
   * reads these as its input evidence.
   */
  async listUnconsolidatedSourceRecords(
    options: UnconsolidatedSourceRecordOptions = {},
  ): Promise<MemorySourceRecord[]> {
    const where: string[] = ["consolidated_at IS NULL"];
    const params: (string | number)[] = [];
    if (options.threadId) {
      where.push("thread_id = ?");
      params.push(options.threadId);
    }
    let sql = `SELECT id, kind, channel_id, thread_id, slack_ts, source_url, actor_id,
                      actor_kind, agent_name, repo_name, body, metadata_json, created_at
               FROM memory_source_record WHERE ${where.join(" AND ")}
               ORDER BY created_at ASC, id ASC`;
    if (options.limit != null) {
      sql += " LIMIT ?";
      params.push(options.limit);
    }
    const rows = this.db.query<SourceRecordRow, (string | number)[]>(sql).all(...params);
    return rows.map(rowToSourceRecord);
  }

  /**
   * Stamp `consolidated_at = now` on the given source records so a later pass
   * does not reprocess them (even when they yielded no derivation — they are
   * still consumed exactly once).
   */
  async markSourceRecordsConsolidated(ids: string[], now: number): Promise<void> {
    const uniqueIds = unique(ids);
    if (uniqueIds.length === 0) return;
    const mark = this.db.query("UPDATE memory_source_record SET consolidated_at = ? WHERE id = ?");
    const txn = this.db.transaction(() => {
      for (const id of uniqueIds) mark.run(now, id);
    });
    txn();
  }

  // --- memory v3: decay / forgetting (§7.1) ---------------------------------

  /**
   * ARCHIVE (set `active = 0`, never DELETE — keep provenance) every active claim
   * that is BOTH stale AND low-value. Stale = `last_used_at` older than the cutoff,
   * or never used and `created_at` older than the cutoff. Low-value = `weight <=
   * maxWeight`. Forget by value AND age — age alone never forgets. Batch/offline.
   */
  async archiveStaleClaims(options: ArchiveStaleClaimsOptions): Promise<ArchiveStaleClaimsResult> {
    const now = options.now ?? Date.now();
    const cutoff = now - options.olderThanMs;
    const rows = this.db
      .query<{ id: string }, [number, number, number]>(
        `SELECT id FROM claim
         WHERE active = 1
           AND weight <= ?
           AND ((last_used_at IS NOT NULL AND last_used_at < ?)
                OR (last_used_at IS NULL AND created_at < ?))`,
      )
      .all(options.maxWeight, cutoff, cutoff);
    const archivedIds = rows.map((row) => row.id);
    if (archivedIds.length > 0) {
      const archive = this.db.query("UPDATE claim SET active = 0 WHERE id = ?");
      const txn = this.db.transaction(() => {
        for (const id of archivedIds) archive.run(id);
      });
      txn();
    }
    return { archivedIds };
  }

  /**
   * Read-only decay summary — per claim kind plus the episode log: corpus size,
   * how many have never been used, the oldest `last_used_at`, and the current
   * fade-candidate count under the supplied (or default) cutoff/ceiling. Never
   * writes; safe for dashboards.
   */
  async memoryHealth(options: MemoryHealthOptions = {}): Promise<MemoryHealth> {
    const now = options.now ?? Date.now();
    const olderThanMs = options.olderThanMs ?? 90 * 24 * 60 * 60 * 1000;
    const maxWeight = options.maxWeight ?? 0.5;
    const cutoff = now - olderThanMs;

    const kinds: MemoryHealthKind[] = [];

    const claimKinds: ClaimKind[] = ["lesson", "fact", "situation-claim"];
    for (const kind of claimKinds) {
      const summary = this.db
        .query<
          { total: number; never_used: number; oldest: number | null },
          [string]
        >(
          `SELECT COUNT(*) AS total,
                  SUM(CASE WHEN last_used_at IS NULL THEN 1 ELSE 0 END) AS never_used,
                  MIN(last_used_at) AS oldest
           FROM claim WHERE active = 1 AND kind = ?`,
        )
        .get(kind);
      const fade = this.db
        .query<{ n: number }, [string, number, number, number]>(
          `SELECT COUNT(*) AS n FROM claim
           WHERE active = 1
             AND kind = ?
             AND weight <= ?
             AND ((last_used_at IS NOT NULL AND last_used_at < ?)
                  OR (last_used_at IS NULL AND created_at < ?))`,
        )
        .get(kind, maxWeight, cutoff, cutoff);
      const total = summary?.total ?? 0;
      const neverUsed = summary?.never_used ?? 0;
      kinds.push({
        kind,
        total,
        neverUsed,
        pctNeverUsed: total > 0 ? neverUsed / total : 0,
        oldestLastUsedAt: summary?.oldest ?? null,
        fadeCandidates: fade?.n ?? 0,
      });
    }

    const episodeSummary = this.db
      .query<{ total: number; never_used: number; oldest: number | null }, []>(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN last_used_at IS NULL THEN 1 ELSE 0 END) AS never_used,
                MIN(last_used_at) AS oldest
         FROM episode`,
      )
      .get();
    const episodeTotal = episodeSummary?.total ?? 0;
    const episodeNeverUsed = episodeSummary?.never_used ?? 0;
    kinds.push({
      kind: "episode",
      total: episodeTotal,
      neverUsed: episodeNeverUsed,
      pctNeverUsed: episodeTotal > 0 ? episodeNeverUsed / episodeTotal : 0,
      oldestLastUsedAt: episodeSummary?.oldest ?? null,
      fadeCandidates: 0, // episodes are never value-archived.
    });

    return { generatedAt: now, olderThanMs, maxWeight, kinds };
  }

  private upsertNode(id: string, kind: string, createdAt: number): void {
    this.db
      .query(
        `INSERT INTO memory_node (id, kind, created_at, valid_at, invalid_at, superseded_by)
         VALUES (?, ?, ?, ?, NULL, NULL)
         ON CONFLICT(id) DO UPDATE SET kind = excluded.kind`,
      )
      .run(id, kind, createdAt, createdAt);
  }

  private replaceProvenance(memoryId: string, sourceIds: string[]): void {
    this.db.query("DELETE FROM memory_provenance WHERE memory_id = ?").run(memoryId);
    const insert = this.db.query(
      "INSERT OR IGNORE INTO memory_provenance (memory_id, source_id) VALUES (?, ?)",
    );
    for (const sourceId of sourceIds) insert.run(memoryId, sourceId);
  }

  private replaceTags(memoryId: string, memoryKind: string, tags: string[]): void {
    this.db.query("DELETE FROM memory_tag WHERE memory_id = ?").run(memoryId);
    for (const tagName of unique(tags.map(normalizeName))) {
      const tagId = `tag:${tagName}`;
      this.upsertNode(tagId, "tag", Date.now());
      this.db
        .query("INSERT OR IGNORE INTO tag (id, name) VALUES (?, ?)")
        .run(tagId, tagName);
      this.db
        .query("INSERT OR IGNORE INTO memory_tag (memory_id, tag_id, memory_kind) VALUES (?, ?, ?)")
        .run(memoryId, tagId, memoryKind);
    }
  }

  private ensureColumn(table: string, column: string, decl: string): void {
    const cols = this.db
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name);
    if (!cols.includes(column)) {
      this.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    }
  }

  /**
   * Widen the memory_node.kind CHECK to allow 'claim' on DBs created before v3.
   * SQLite can't ALTER a CHECK, and CREATE TABLE IF NOT EXISTS won't retrofit
   * one, so an old node table would reject the memory_node row that upsertClaim
   * writes. Rebuild the table (it has no extra indexes/triggers; FK enforcement
   * is off) only when the current CHECK lacks 'claim' — idempotent thereafter.
   */
  private ensureMemoryNodeAllowsClaim(): void {
    const row = this.db
      .query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='memory_node'",
      )
      .get();
    if (!row || row.sql.includes("'claim'")) return;
    this.db.transaction(() => {
      this.db.run(
        `CREATE TABLE memory_node_new (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('event', 'lesson', 'summary', 'fact', 'procedure', 'routing_memory', 'entity', 'tag', 'claim')), created_at INTEGER NOT NULL, valid_at INTEGER, invalid_at INTEGER, superseded_by TEXT)`,
      );
      this.db.run(
        "INSERT INTO memory_node_new (id, kind, created_at, valid_at, invalid_at, superseded_by) SELECT id, kind, created_at, valid_at, invalid_at, superseded_by FROM memory_node",
      );
      this.db.run("DROP TABLE memory_node");
      this.db.run("ALTER TABLE memory_node_new RENAME TO memory_node");
    })();
  }

  private migrate(): void {
    this.db.run(`CREATE TABLE IF NOT EXISTS memory_source_record (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('slack_message', 'runner_output', 'routing_decision', 'routing_correction', 'ingestion_correction', 'curated_fact', 'manual_correction')), channel_id TEXT, thread_id TEXT, slack_ts TEXT, source_url TEXT, actor_id TEXT, actor_kind TEXT CHECK (actor_kind IN ('human', 'junior', 'agent', 'bot', 'system')), agent_name TEXT, repo_name TEXT, body TEXT NOT NULL, metadata_json TEXT, created_at INTEGER NOT NULL)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS memory_node (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('event', 'lesson', 'summary', 'fact', 'procedure', 'routing_memory', 'entity', 'tag', 'claim')), created_at INTEGER NOT NULL, valid_at INTEGER, invalid_at INTEGER, superseded_by TEXT)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS lesson (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, applies_when TEXT, importance REAL DEFAULT 0.5, created_at INTEGER NOT NULL, last_used_at INTEGER, use_count INTEGER DEFAULT 0, active INTEGER DEFAULT 1, FOREIGN KEY (id) REFERENCES memory_node(id))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS memory_fact (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('curated_fact', 'routing_memory', 'procedure')), title TEXT, body TEXT NOT NULL, confidence REAL DEFAULT 0.5, importance REAL DEFAULT 0.5, created_at INTEGER NOT NULL, last_used_at INTEGER, use_count INTEGER DEFAULT 0, active INTEGER DEFAULT 1, FOREIGN KEY (id) REFERENCES memory_node(id))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS entity (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, FOREIGN KEY (id) REFERENCES memory_node(id))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS tag (id TEXT PRIMARY KEY, name TEXT NOT NULL, FOREIGN KEY (id) REFERENCES memory_node(id))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS memory_tag (memory_id TEXT NOT NULL, tag_id TEXT NOT NULL, memory_kind TEXT NOT NULL CHECK (memory_kind IN ('event', 'lesson', 'summary', 'fact', 'procedure', 'routing_memory')), PRIMARY KEY (memory_id, tag_id))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS memory_provenance (memory_id TEXT NOT NULL, source_id TEXT NOT NULL, PRIMARY KEY (memory_id, source_id))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS ingestion_classification (event_id TEXT NOT NULL, input_text TEXT NOT NULL, extracted_mentions_json TEXT NOT NULL, assigned_tags_json TEXT NOT NULL, assigned_event_types_json TEXT NOT NULL, created_edges_json TEXT NOT NULL, extractor TEXT NOT NULL, confidence REAL NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (event_id, extractor, created_at))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS ingestion_correction (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL, field TEXT NOT NULL, incorrect_value TEXT, correct_value TEXT, corrected_by TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS consolidation_decision (id TEXT PRIMARY KEY, event_id TEXT NOT NULL, action TEXT NOT NULL, reason TEXT NOT NULL, source_ids_json TEXT NOT NULL, extractor TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS recall_log (id INTEGER PRIMARY KEY AUTOINCREMENT, query TEXT, tags_json TEXT, entities_json TEXT, kinds_json TEXT, caller_intent TEXT, returned_ids_json TEXT NOT NULL, result_count INTEGER NOT NULL, created_at INTEGER NOT NULL)`);
    // memory v3: semantic claim store (text + embedding co-located) — mirrors the lesson/memory_node relationship.
    this.db.run(`CREATE TABLE IF NOT EXISTS claim (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('lesson', 'fact', 'situation-claim')), text TEXT NOT NULL, embedding BLOB, embed_model TEXT, dim INTEGER, repo TEXT, tags TEXT, source_episode TEXT, helpful_count INTEGER DEFAULT 0, unhelpful_count INTEGER DEFAULT 0, weight REAL DEFAULT 1.0, created_at INTEGER, last_used_at INTEGER, active INTEGER DEFAULT 1, FOREIGN KEY (id) REFERENCES memory_node(id))`);
    // memory v3: raw episodic log (affect sidecar over memory_source_record).
    this.db.run(`CREATE TABLE IF NOT EXISTS episode (id TEXT PRIMARY KEY, actor TEXT, subjects_json TEXT, what TEXT, emotion TEXT, intensity REAL, valence REAL, trigger TEXT, response TEXT, salience REAL, consolidated_into_json TEXT, created_at INTEGER NOT NULL, last_used_at INTEGER, FOREIGN KEY (id) REFERENCES memory_source_record(id))`);
    this.ensureColumn("episode", "last_used_at", "INTEGER");
    // memory v3: consolidation bookkeeping — which raw source records have been
    // folded into a derivation (idempotent ALTER for DBs created before this).
    this.ensureColumn("memory_source_record", "consolidated_at", "INTEGER");
    // memory v3: retrofit the memory_node.kind CHECK to allow 'claim' on old DBs.
    this.ensureMemoryNodeAllowsClaim();
    this.db.run("CREATE INDEX IF NOT EXISTS memory_tag_tag_idx ON memory_tag(tag_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS recall_log_created_idx ON recall_log(created_at)");
    this.db.run("CREATE INDEX IF NOT EXISTS claim_repo_idx ON claim(repo)");
    this.db.run("CREATE INDEX IF NOT EXISTS claim_kind_idx ON claim(kind)");
    this.db.run("CREATE INDEX IF NOT EXISTS claim_active_created_idx ON claim(active, created_at)");
    this.db.run("CREATE INDEX IF NOT EXISTS episode_created_idx ON episode(created_at)");
    this.db.run("CREATE INDEX IF NOT EXISTS source_record_unconsolidated_idx ON memory_source_record(consolidated_at, created_at)");
  }
}

/** Map a raw `memory_source_record` row to the public `MemorySourceRecord`. */
function rowToSourceRecord(row: SourceRecordRow): MemorySourceRecord {
  return {
    id: row.id,
    kind: row.kind as MemorySourceRecord["kind"],
    channelId: row.channel_id,
    threadId: row.thread_id,
    slackTs: row.slack_ts,
    sourceUrl: row.source_url,
    actorId: row.actor_id,
    actorKind: row.actor_kind as MemorySourceRecord["actorKind"],
    agentName: row.agent_name,
    repoName: row.repo_name,
    body: row.body,
    metadata: row.metadata_json ? (JSON.parse(row.metadata_json) as Record<string, unknown>) : null,
    createdAt: row.created_at,
  };
}

/** Serialize a Float32Array to a little-endian BLOB (Buffer) for SQLite. */
function serializeEmbedding(vec: Float32Array): Buffer {
  const buf = Buffer.allocUnsafe(vec.length * 4);
  for (let i = 0; i < vec.length; i += 1) buf.writeFloatLE(vec[i], i * 4);
  return buf;
}

/** Deserialize a little-endian BLOB back into a Float32Array. */
function deserializeEmbedding(blob: Uint8Array | null): Float32Array | null {
  if (!blob || blob.byteLength === 0) return null;
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  const out = new Float32Array(Math.floor(buf.byteLength / 4));
  for (let i = 0; i < out.length; i += 1) out[i] = buf.readFloatLE(i * 4);
  return out;
}

/** Cosine similarity. Returns 0 for mismatched dims or a zero vector. */
function cosineSim(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "_");
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values.filter(Boolean))];
}
