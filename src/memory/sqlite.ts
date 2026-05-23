import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { MemoryStore } from "./store.ts";
import type {
  CandidateRuleInput,
  ConsolidationDecisionRecord,
  ConsolidationOptions,
  ConsolidationResult,
  IngestionClassificationInput,
  IngestionCorrectionInput,
  MemoryEdgeInput,
  MemoryEventInput,
  MemoryFactInput,
  MemoryLessonInput,
  MemoryRecallOptions,
  MemorySearchResult,
  MemorySourceRecord,
  SearchableMemoryKind,
} from "./types.ts";

type CandidateRow = {
  id: string;
  kind: SearchableMemoryKind;
  title: string | null;
  body: string;
  outcome: string | null;
  fts_rank: number | null;
  importance: number | null;
  use_count: number | null;
  created_at: number | null;
  active: number | null;
  invalid_at: number | null;
  superseded_by: string | null;
  source_ids: string | null;
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
        `INSERT INTO memory_source_record (
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

  async upsertEvent(event: MemoryEventInput): Promise<void> {
    const importance = event.importance ?? 0.5;
    const txn = this.db.transaction(() => {
      this.upsertNode(event.id, "event", event.createdAt);
      this.db
        .query(
          `INSERT INTO memory_event (
            id, source_record_id, thread_id, summary_id, body, outcome,
            importance, created_at, source_ts, source_url
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            source_record_id = excluded.source_record_id,
            thread_id = excluded.thread_id,
            summary_id = excluded.summary_id,
            body = excluded.body,
            outcome = excluded.outcome,
            importance = excluded.importance,
            source_ts = excluded.source_ts,
            source_url = excluded.source_url`,
        )
        .run(
          event.id,
          event.sourceRecordId,
          event.threadId,
          event.summaryId ?? null,
          event.body,
          event.outcome ?? null,
          importance,
          event.createdAt,
          event.sourceTs ?? null,
          event.sourceUrl ?? null,
        );
      this.replaceProvenance(event.id, [event.sourceRecordId]);
      this.replaceTags(event.id, "event", event.tags ?? []);
      this.replaceEntities(event.id, "event", event.entities ?? []);
      this.upsertSearchDoc({
        id: event.id,
        kind: "event",
        title: null,
        body: event.body,
        outcome: event.outcome ?? null,
        updatedAt: Date.now(),
      });
    });
    txn();
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
      this.replaceEntities(lesson.id, "lesson", lesson.entities ?? []);
      for (const sourceId of lesson.sourceIds ?? []) {
        this.addEdgeSync({
          srcId: sourceId,
          dstId: lesson.id,
          type: "lesson_from",
          weight: 1,
          directed: true,
          createdAt: lesson.createdAt,
        });
      }
      this.upsertSearchDoc({
        id: lesson.id,
        kind: "lesson",
        title: lesson.title,
        body: lesson.body,
        outcome: lesson.appliesWhen ?? null,
        updatedAt: Date.now(),
      });
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
      this.replaceEntities(fact.id, nodeKind, fact.entities ?? []);
      this.upsertSearchDoc({
        id: fact.id,
        kind: nodeKind,
        title: fact.title ?? null,
        body: fact.body,
        outcome: null,
        updatedAt: Date.now(),
      });
    });
    txn();
  }

  async addEdge(edge: MemoryEdgeInput): Promise<void> {
    this.addEdgeSync(edge);
  }

  async logClassification(classification: IngestionClassificationInput): Promise<void> {
    this.db
      .query(
        `INSERT INTO ingestion_classification (
          event_id, input_text, extracted_mentions_json, assigned_tags_json,
          assigned_event_types_json, created_edges_json, extractor, confidence, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(event_id, extractor, created_at) DO UPDATE SET
          input_text = excluded.input_text,
          extracted_mentions_json = excluded.extracted_mentions_json,
          assigned_tags_json = excluded.assigned_tags_json,
          assigned_event_types_json = excluded.assigned_event_types_json,
          created_edges_json = excluded.created_edges_json,
          confidence = excluded.confidence`,
      )
      .run(
        classification.eventId,
        classification.inputText,
        JSON.stringify(classification.extractedMentions),
        JSON.stringify(classification.assignedTags),
        JSON.stringify(classification.assignedEventTypes),
        JSON.stringify(classification.createdEdges),
        classification.extractor,
        classification.confidence,
        classification.createdAt,
      );
  }

  async logCorrection(correction: IngestionCorrectionInput): Promise<void> {
    this.db
      .query(
        `INSERT INTO ingestion_correction (
          event_id, field, incorrect_value, correct_value, corrected_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        correction.eventId,
        correction.field,
        correction.incorrectValue ?? null,
        correction.correctValue ?? null,
        correction.correctedBy,
        correction.createdAt,
      );
  }

  async proposeRule(rule: CandidateRuleInput): Promise<void> {
    this.db
      .query(
        `INSERT INTO candidate_rule (
          id, status, domain, rule_text, positive_example_ids_json,
          negative_example_ids_json, precision, recall, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          domain = excluded.domain,
          rule_text = excluded.rule_text,
          positive_example_ids_json = excluded.positive_example_ids_json,
          negative_example_ids_json = excluded.negative_example_ids_json,
          precision = excluded.precision,
          recall = excluded.recall`,
      )
      .run(
        rule.id,
        rule.status ?? "draft",
        rule.domain,
        rule.ruleText,
        JSON.stringify(rule.positiveExampleIds),
        JSON.stringify(rule.negativeExampleIds),
        rule.precision ?? null,
        rule.recall ?? null,
        rule.createdAt,
      );
  }

  async search(
    query: string,
    options: { limit?: number } = {},
  ): Promise<MemorySearchResult[]> {
    return this.recall({ query, limit: options.limit });
  }

  async recall(options: MemoryRecallOptions): Promise<MemorySearchResult[]> {
    const limit = options.limit ?? 5;
    const depth = Math.min(Math.max(options.depth ?? 2, 0), 3);
    const candidates = new Map<string, CandidateRow & { reasons: string[]; activation: number }>();

    for (const row of this.ftsRows(options.query, limit * 4)) {
      candidates.set(row.id, {
        ...row,
        reasons: [`FTS matched query ${JSON.stringify(options.query!.trim())}`],
        activation: Math.max(0, 5 - Math.abs(row.fts_rank ?? 0)),
      });
    }

    const seedIds = new Set<string>(candidates.keys());
    for (const row of this.tagEntityRows(options.tags ?? [], options.entities ?? [])) {
      const existing = candidates.get(row.id);
      if (existing) {
        existing.reasons.push("Matched requested tag/entity");
        existing.activation += 2;
      } else {
        candidates.set(row.id, {
          ...row,
          reasons: ["Matched requested tag/entity"],
          activation: 2,
        });
      }
      seedIds.add(row.id);
    }

    if (depth > 0 && seedIds.size > 0) {
      for (const row of this.edgeRows([...seedIds], depth, limit * 6)) {
        const existing = candidates.get(row.id);
        if (existing) {
          existing.reasons.push(`Related by edge traversal (${row.fts_rank?.toFixed(2)})`);
          existing.activation += row.fts_rank ?? 0;
        } else {
          candidates.set(row.id, {
            ...row,
            reasons: ["Related by edge traversal"],
            activation: row.fts_rank ?? 0,
          });
        }
      }
    }

    return [...candidates.values()]
      .filter((row) => this.recallFilter(row, options))
      .map((row) => this.toResult(row))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async consolidate(options: ConsolidationOptions = {}): Promise<ConsolidationResult> {
    const now = options.now ?? Date.now();
    const archiveBeforeMs = options.archiveBeforeMs ?? 30 * 24 * 60 * 60 * 1000;
    const lowImportance = options.lowImportanceThreshold ?? 0.2;
    const repeatedThreshold = options.repeatedCorrectionThreshold ?? 2;
    const decisions: ConsolidationDecisionRecord[] = [];
    const promotedMemoryIds: string[] = [];
    const archivedEventIds: string[] = [];
    const proposedRuleIds: string[] = [];

    const archiveRows = this.db
      .query<{ id: string; source_record_id: string }, [number, number]>(
        `SELECT id, source_record_id FROM memory_event
         WHERE active = 1 AND importance <= ? AND use_count = 0 AND created_at < ?`,
      )
      .all(lowImportance, now - archiveBeforeMs);
    for (const row of archiveRows) {
      this.db.query("UPDATE memory_event SET active = 0 WHERE id = ?").run(row.id);
      const decision = this.recordDecision({
        id: `decision_archive_${row.id}_${now}`,
        eventId: row.id,
        action: "archive",
        reason: "Archived old, low-importance, unused event from active recall set.",
        sourceIds: [row.source_record_id],
        extractor: "heuristic",
        createdAt: now,
      });
      decisions.push(decision);
      archivedEventIds.push(row.id);
    }

    const correctionGroups = this.db
      .query<{ correct_value: string; event_ids: string; count: number }, [number]>(
        `SELECT correct_value, group_concat(event_id) AS event_ids, COUNT(*) AS count
         FROM ingestion_correction
         WHERE field = 'routing_fact' AND correct_value IS NOT NULL
         GROUP BY field, correct_value
         HAVING count >= ?`,
      )
      .all(repeatedThreshold);
    for (const group of correctionGroups) {
      const eventIds = group.event_ids.split(",");
      const factId = `routing_memory_${slug(group.correct_value)}`;
      await this.upsertFact({
        id: factId,
        kind: "routing_memory",
        title: `Learned routing memory: ${group.correct_value}`,
        body: group.correct_value,
        confidence: Math.min(0.95, 0.5 + group.count * 0.1),
        importance: 0.8,
        createdAt: now,
        sourceIds: eventIds,
        tags: ["routing_memory", "learned_correction"],
      });
      const decision = this.recordDecision({
        id: `decision_promote_${factId}_${now}`,
        eventId: eventIds[0],
        action: "promote_routing_memory",
        reason: `Promoted repeated correction (${group.count} examples) into routing memory.`,
        sourceIds: eventIds,
        extractor: "heuristic",
        createdAt: now,
      });
      decisions.push(decision);
      promotedMemoryIds.push(factId);
    }

    const ruleRows = this.db
      .query<{ correct_value: string; event_ids: string; count: number }, [number]>(
        `SELECT correct_value, group_concat(event_id) AS event_ids, COUNT(*) AS count
         FROM ingestion_correction
         WHERE field = 'tag' AND correct_value IS NOT NULL
         GROUP BY correct_value
         HAVING count >= ?`,
      )
      .all(repeatedThreshold);
    for (const row of ruleRows) {
      const ruleId = `rule_tag_${slug(row.correct_value)}`;
      await this.proposeRule({
        id: ruleId,
        status: "draft",
        domain: "tag",
        ruleText: `tag(Event, ${slug(row.correct_value)}) :- mentions_corrected_value(Event, ${slug(row.correct_value)}).`,
        positiveExampleIds: row.event_ids.split(","),
        negativeExampleIds: [],
        precision: null,
        recall: null,
        createdAt: now,
      });
      const decision = this.recordDecision({
        id: `decision_rule_${ruleId}_${now}`,
        eventId: row.event_ids.split(",")[0],
        action: "propose_rule",
        reason: "Proposed draft bounded-DSL rule from repeated tag corrections.",
        sourceIds: row.event_ids.split(","),
        extractor: "heuristic",
        createdAt: now,
      });
      decisions.push(decision);
      proposedRuleIds.push(ruleId);
    }

    return { decisions, promotedMemoryIds, archivedEventIds, proposedRuleIds };
  }

  async rebuildSearchIndex(): Promise<void> {
    const txn = this.db.transaction(() => {
      this.db.run("DELETE FROM memory_fts");
      this.db.run(
        `INSERT INTO memory_fts (id, kind, title, body, outcome)
         SELECT id, kind, title, body, outcome FROM memory_search_doc`,
      );
    });
    txn();
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

  private addEdgeSync(edge: MemoryEdgeInput): void {
    this.db
      .query(
        `INSERT INTO edge (src_id, dst_id, type, weight, directed, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(src_id, dst_id, type) DO UPDATE SET
           weight = excluded.weight,
           directed = excluded.directed`,
      )
      .run(
        edge.srcId,
        edge.dstId,
        edge.type,
        edge.weight ?? 1,
        edge.directed === false ? 0 : 1,
        edge.createdAt,
      );
    if (edge.type === "supersedes") {
      this.db
        .query("UPDATE memory_node SET invalid_at = ?, superseded_by = ? WHERE id = ?")
        .run(edge.createdAt, edge.srcId, edge.dstId);
    }
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
      this.addEdgeSync({ srcId: memoryId, dstId: tagId, type: "tagged_as", createdAt: Date.now() });
    }
  }

  private replaceEntities(
    memoryId: string,
    memoryKind: string,
    entities: Array<{ name: string; kind: string }>,
  ): void {
    this.db.query("DELETE FROM mention WHERE memory_id = ?").run(memoryId);
    for (const entity of entities) {
      const name = normalizeName(entity.name);
      const kind = normalizeName(entity.kind);
      const entityId = `entity:${kind}:${name}`;
      this.upsertNode(entityId, "entity", Date.now());
      this.db
        .query("INSERT OR IGNORE INTO entity (id, name, kind) VALUES (?, ?, ?)")
        .run(entityId, name, kind);
      this.db
        .query("INSERT OR IGNORE INTO mention (memory_id, entity_id, memory_kind) VALUES (?, ?, ?)")
        .run(memoryId, entityId, memoryKind);
      this.addEdgeSync({ srcId: memoryId, dstId: entityId, type: "mentions", createdAt: Date.now() });
    }
  }

  private upsertSearchDoc(doc: {
    id: string;
    kind: SearchableMemoryKind;
    title: string | null;
    body: string;
    outcome: string | null;
    updatedAt: number;
  }): void {
    this.db
      .query(
        `INSERT INTO memory_search_doc (id, kind, title, body, outcome, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind,
           title = excluded.title,
           body = excluded.body,
           outcome = excluded.outcome,
           updated_at = excluded.updated_at`,
      )
      .run(doc.id, doc.kind, doc.title, doc.body, doc.outcome, doc.updatedAt);
    this.db.query("DELETE FROM memory_fts WHERE id = ?").run(doc.id);
    this.db
      .query(`INSERT INTO memory_fts (id, kind, title, body, outcome) VALUES (?, ?, ?, ?, ?)`)
      .run(doc.id, doc.kind, doc.title, doc.body, doc.outcome);
  }

  private ftsRows(query: string | undefined, limit: number): CandidateRow[] {
    const normalized = query?.trim();
    if (!normalized) return [];
    return this.db
      .query<CandidateRow, [string, number]>(
        `WITH hits AS (
           SELECT id, bm25(memory_fts) AS rank
           FROM memory_fts
           WHERE memory_fts MATCH ?
           ORDER BY rank
           LIMIT ?
         )
         ${candidateSelect("hits.rank")}
         FROM hits
         JOIN memory_search_doc d ON d.id = hits.id
         JOIN memory_node n ON n.id = d.id
         LEFT JOIN memory_event e ON e.id = d.id
         LEFT JOIN lesson l ON l.id = d.id
         LEFT JOIN memory_fact f ON f.id = d.id
         LEFT JOIN memory_provenance p ON p.memory_id = d.id
         GROUP BY d.id
         ORDER BY fts_rank`,
      )
      .all(toFtsQuery(normalized), limit);
  }

  private tagEntityRows(tags: string[], entities: string[]): CandidateRow[] {
    const tagIds = unique(tags.map((tag) => `tag:${normalizeName(tag)}`));
    const entityNames = unique(entities.map(normalizeName));
    if (tagIds.length === 0 && entityNames.length === 0) return [];
    const rows: CandidateRow[] = [];
    for (const tagId of tagIds) {
      rows.push(...this.rowsForJoin("memory_tag", "tag_id", tagId));
    }
    for (const name of entityNames) {
      const entityRows = this.db
        .query<{ id: string }, [string]>("SELECT id FROM entity WHERE name = ?")
        .all(name);
      for (const entity of entityRows) {
        rows.push(...this.rowsForJoin("mention", "entity_id", entity.id));
      }
    }
    return rows;
  }

  private rowsForJoin(table: "memory_tag" | "mention", column: string, value: string): CandidateRow[] {
    return this.db
      .query<CandidateRow, [string]>(
        `${candidateSelect("NULL")}
         FROM ${table} j
         JOIN memory_search_doc d ON d.id = j.memory_id
         JOIN memory_node n ON n.id = d.id
         LEFT JOIN memory_event e ON e.id = d.id
         LEFT JOIN lesson l ON l.id = d.id
         LEFT JOIN memory_fact f ON f.id = d.id
         LEFT JOIN memory_provenance p ON p.memory_id = d.id
         WHERE j.${column} = ?
         GROUP BY d.id`,
      )
      .all(value);
  }

  private edgeRows(seedIds: string[], depth: number, limit: number): CandidateRow[] {
    const seedJson = JSON.stringify(seedIds);
    return this.db
      .query<CandidateRow, [string, number, number]>(
        `WITH RECURSIVE seed(id) AS (
           SELECT value FROM json_each(?1)
         ), related(id, depth, score, path) AS (
           SELECT e.dst_id, 1, e.weight, e.src_id || '>' || e.dst_id
           FROM edge e JOIN seed s ON s.id = e.src_id
           UNION ALL
           SELECT e.dst_id, r.depth + 1, r.score * e.weight * 0.7, r.path || '>' || e.dst_id
           FROM edge e JOIN related r ON e.src_id = r.id
           WHERE r.depth < ?2 AND instr(r.path, e.dst_id) = 0
         ), ranked AS (
           SELECT id, MAX(score) AS edge_score FROM related GROUP BY id ORDER BY edge_score DESC LIMIT ?3
         )
         ${candidateSelect("ranked.edge_score")}
         FROM ranked
         JOIN memory_search_doc d ON d.id = ranked.id
         JOIN memory_node n ON n.id = d.id
         LEFT JOIN memory_event e ON e.id = d.id
         LEFT JOIN lesson l ON l.id = d.id
         LEFT JOIN memory_fact f ON f.id = d.id
         LEFT JOIN memory_provenance p ON p.memory_id = d.id
         GROUP BY d.id`,
      )
      .all(seedJson, depth, limit);
  }

  private recallFilter(row: CandidateRow, options: MemoryRecallOptions): boolean {
    if (!options.includeInactive && row.active === 0) return false;
    if (!options.includeInvalid && row.invalid_at != null) return false;
    if (options.kinds && !options.kinds.includes(row.kind)) return false;
    return true;
  }

  private toResult(row: CandidateRow & { reasons: string[]; activation: number }): MemorySearchResult {
    const importance = row.importance ?? 0.5;
    const frequency = Math.min(row.use_count ?? 0, 10) * 0.05;
    const recency = row.created_at ? Math.max(0, 1 - (Date.now() - row.created_at) / (90 * 24 * 60 * 60 * 1000)) : 0;
    return {
      id: row.id,
      kind: row.kind,
      title: row.title,
      body: row.body,
      outcome: row.outcome,
      score: row.activation + importance + frequency + recency,
      reasons: unique(row.reasons),
      sourceIds: row.source_ids ? row.source_ids.split(",").filter(Boolean) : [],
    };
  }

  private recordDecision(decision: ConsolidationDecisionRecord): ConsolidationDecisionRecord {
    this.db
      .query(
        `INSERT INTO consolidation_decision (id, event_id, action, reason, source_ids_json, extractor, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        decision.id,
        decision.eventId,
        decision.action,
        decision.reason,
        JSON.stringify(decision.sourceIds),
        decision.extractor,
        decision.createdAt,
      );
    return decision;
  }

  private migrate(): void {
    this.db.run(`CREATE TABLE IF NOT EXISTS memory_source_record (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('slack_message', 'runner_output', 'routing_decision', 'routing_correction', 'ingestion_correction', 'curated_fact', 'manual_correction')), channel_id TEXT, thread_id TEXT, slack_ts TEXT, source_url TEXT, actor_id TEXT, actor_kind TEXT CHECK (actor_kind IN ('human', 'junior', 'agent', 'bot', 'system')), agent_name TEXT, repo_name TEXT, body TEXT NOT NULL, metadata_json TEXT, created_at INTEGER NOT NULL)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS memory_node (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('event', 'lesson', 'summary', 'fact', 'procedure', 'routing_memory', 'entity', 'tag')), created_at INTEGER NOT NULL, valid_at INTEGER, invalid_at INTEGER, superseded_by TEXT)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS memory_event (id TEXT PRIMARY KEY, source_record_id TEXT NOT NULL, thread_id TEXT NOT NULL, summary_id TEXT, body TEXT NOT NULL, outcome TEXT, importance REAL DEFAULT 0.5, created_at INTEGER NOT NULL, last_used_at INTEGER, use_count INTEGER DEFAULT 0, active INTEGER DEFAULT 1, source_ts TEXT, source_url TEXT, FOREIGN KEY (source_record_id) REFERENCES memory_source_record(id), FOREIGN KEY (id) REFERENCES memory_node(id))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS lesson (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, applies_when TEXT, importance REAL DEFAULT 0.5, created_at INTEGER NOT NULL, last_used_at INTEGER, use_count INTEGER DEFAULT 0, active INTEGER DEFAULT 1, FOREIGN KEY (id) REFERENCES memory_node(id))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS memory_fact (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('curated_fact', 'routing_memory', 'procedure')), title TEXT, body TEXT NOT NULL, confidence REAL DEFAULT 0.5, importance REAL DEFAULT 0.5, created_at INTEGER NOT NULL, last_used_at INTEGER, use_count INTEGER DEFAULT 0, active INTEGER DEFAULT 1, FOREIGN KEY (id) REFERENCES memory_node(id))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS entity (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, FOREIGN KEY (id) REFERENCES memory_node(id))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS tag (id TEXT PRIMARY KEY, name TEXT NOT NULL, FOREIGN KEY (id) REFERENCES memory_node(id))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS memory_tag (memory_id TEXT NOT NULL, tag_id TEXT NOT NULL, memory_kind TEXT NOT NULL CHECK (memory_kind IN ('event', 'lesson', 'summary', 'fact', 'procedure', 'routing_memory')), PRIMARY KEY (memory_id, tag_id))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS mention (memory_id TEXT NOT NULL, entity_id TEXT NOT NULL, memory_kind TEXT NOT NULL CHECK (memory_kind IN ('event', 'lesson', 'summary', 'fact', 'procedure', 'routing_memory')), PRIMARY KEY (memory_id, entity_id))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS edge (src_id TEXT NOT NULL, dst_id TEXT NOT NULL, type TEXT NOT NULL, weight REAL DEFAULT 1, directed INTEGER DEFAULT 1, created_at INTEGER NOT NULL, PRIMARY KEY (src_id, dst_id, type), FOREIGN KEY (src_id) REFERENCES memory_node(id), FOREIGN KEY (dst_id) REFERENCES memory_node(id))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS memory_search_doc (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('event', 'lesson', 'summary', 'fact', 'procedure', 'routing_memory')), title TEXT, body TEXT NOT NULL, outcome TEXT, updated_at INTEGER NOT NULL, FOREIGN KEY (id) REFERENCES memory_node(id))`);
    this.db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(id UNINDEXED, kind UNINDEXED, title, body, outcome)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS memory_provenance (memory_id TEXT NOT NULL, source_id TEXT NOT NULL, PRIMARY KEY (memory_id, source_id))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS ingestion_classification (event_id TEXT NOT NULL, input_text TEXT NOT NULL, extracted_mentions_json TEXT NOT NULL, assigned_tags_json TEXT NOT NULL, assigned_event_types_json TEXT NOT NULL, created_edges_json TEXT NOT NULL, extractor TEXT NOT NULL, confidence REAL NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (event_id, extractor, created_at))`);
    this.db.run(`CREATE TABLE IF NOT EXISTS ingestion_correction (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL, field TEXT NOT NULL, incorrect_value TEXT, correct_value TEXT, corrected_by TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS consolidation_decision (id TEXT PRIMARY KEY, event_id TEXT NOT NULL, action TEXT NOT NULL, reason TEXT NOT NULL, source_ids_json TEXT NOT NULL, extractor TEXT NOT NULL, created_at INTEGER NOT NULL)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS candidate_rule (id TEXT PRIMARY KEY, status TEXT NOT NULL, domain TEXT NOT NULL, rule_text TEXT NOT NULL, positive_example_ids_json TEXT NOT NULL, negative_example_ids_json TEXT NOT NULL, precision REAL, recall REAL, created_at INTEGER NOT NULL)`);
    this.db.run("CREATE INDEX IF NOT EXISTS edge_src_idx ON edge(src_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS edge_dst_idx ON edge(dst_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS edge_type_src_idx ON edge(type, src_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS memory_tag_tag_idx ON memory_tag(tag_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS mention_entity_idx ON mention(entity_id)");
  }
}

function candidateSelect(scoreExpr: string): string {
  return `SELECT d.id, d.kind, d.title, d.body, d.outcome, ${scoreExpr} AS fts_rank,
    COALESCE(e.importance, l.importance, f.importance) AS importance,
    COALESCE(e.use_count, l.use_count, f.use_count) AS use_count,
    COALESCE(e.created_at, l.created_at, f.created_at, n.created_at) AS created_at,
    COALESCE(e.active, l.active, f.active, 1) AS active,
    n.invalid_at, n.superseded_by, group_concat(p.source_id) AS source_ids`;
}

function toFtsQuery(query: string): string {
  return query
    .split(/\s+/)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" ");
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "_");
}

function slug(value: string): string {
  return normalizeName(value).replace(/[^a-z0-9_:-]/g, "_").slice(0, 80) || "unknown";
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values.filter(Boolean))];
}
