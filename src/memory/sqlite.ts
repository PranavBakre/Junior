import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { MemoryStore, AcceptedRule } from "./store.ts";
import type {
  CandidateRuleInput,
  ClaimInput,
  ClaimKind,
  ClaimRecallOptions,
  ClaimRecallResult,
  ClaimVectorExport,
  ConsolidationDecisionRecord,
  ConsolidationOptions,
  ConsolidationResult,
  EpisodeInput,
  IngestionClassificationInput,
  IngestionCorrectionInput,
  MemoryEdgeInput,
  MemoryEventInput,
  MemoryFactInput,
  MemoryFactUpdate,
  MemoryLessonInput,
  MemoryLessonUpdate,
  MemoryMergeResult,
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

  async updateLesson(id: string, update: MemoryLessonUpdate): Promise<void> {
    const txn = this.db.transaction(() => {
      this.db
        .query(
          `UPDATE lesson SET
             title = COALESCE(?1, title),
             body = COALESCE(?2, body),
             applies_when = COALESCE(?3, applies_when),
             importance = COALESCE(?4, importance)
           WHERE id = ?5`,
        )
        .run(update.title ?? null, update.body ?? null, update.appliesWhen ?? null, update.importance ?? null, id);

      this.upsertProvenance(id, update.addSourceIds ?? []);
      this.upsertTags(id, "lesson", update.addTags ?? []);
      this.upsertEntities(id, "lesson", update.addEntities ?? []);

      const current = this.db
        .query<{ title: string; body: string; applies_when: string | null }, [string]>(
          "SELECT title, body, applies_when FROM lesson WHERE id = ?",
        )
        .get(id);
      if (current) {
        this.upsertSearchDoc({
          id,
          kind: "lesson",
          title: current.title,
          body: current.body,
          outcome: current.applies_when ?? null,
          updatedAt: Date.now(),
        });
      }
    });
    txn();
  }

  async updateFact(id: string, update: MemoryFactUpdate): Promise<void> {
    const txn = this.db.transaction(() => {
      this.db
        .query(
          `UPDATE memory_fact SET
             kind = COALESCE(?1, kind),
             title = COALESCE(?2, title),
             body = COALESCE(?3, body),
             confidence = COALESCE(?4, confidence),
             importance = COALESCE(?5, importance)
           WHERE id = ?6`,
        )
        .run(update.kind ?? null, update.title ?? null, update.body ?? null, update.confidence ?? null, update.importance ?? null, id);

      const current = this.db
        .query<{ kind: string; title: string | null; body: string; created_at: number }, [string]>(
          "SELECT kind, title, body, created_at FROM memory_fact WHERE id = ?",
        )
        .get(id);
      if (!current) return;

      const nodeKind = current.kind === "curated_fact" ? "fact" : current.kind as SearchableMemoryKind;
      this.upsertNode(id, nodeKind, current.created_at);
      this.upsertProvenance(id, update.addSourceIds ?? []);
      this.upsertTags(id, nodeKind, update.addTags ?? []);
      this.upsertEntities(id, nodeKind, update.addEntities ?? []);

      this.upsertSearchDoc({
        id,
        kind: nodeKind,
        title: current.title ?? null,
        body: current.body,
        outcome: null,
        updatedAt: Date.now(),
      });
    });
    txn();
  }

  async mergeLessons(ids: string[], title: string): Promise<MemoryMergeResult> {
    const now = Date.now();
    const mergedId = `lesson_merged_${slug(title)}_${now}`;
    const idsJson = JSON.stringify(ids);

    const sources = this.db
      .query<
        { id: string; title: string; body: string; applies_when: string | null; importance: number; created_at: number },
        [string]
      >(
        `SELECT id, title, body, applies_when, importance, created_at
         FROM lesson WHERE id IN (SELECT value FROM json_each(?)) AND active = 1`,
      )
      .all(idsJson);

    if (sources.length === 0) throw new Error("No active lessons found with the given IDs");

    const { sourceIds, allTags, allEntities } = this.collectMetadata(sources.map((s) => s.id));

    const mergedBody = [
      `Merged from: ${sources.map((s) => s.id).join(", ")}`,
      ...sources.map((s) => {
        const appliesLine = s.applies_when ? `\nApplies when: ${s.applies_when}` : "";
        return `---\n[${s.id}] ${s.title}${appliesLine}\n\n${s.body}`;
      }),
    ].join("\n\n");

    const maxImportance = Math.max(...sources.map((s) => s.importance));
    const minCreatedAt = Math.min(...sources.map((s) => s.created_at));
    const entities = [...allEntities.entries()].map(([name, kind]) => ({ name, kind }));

    const txn = this.db.transaction(() => {
      this.upsertNode(mergedId, "lesson", minCreatedAt);
      this.db
        .query(
          `INSERT INTO lesson (id, title, body, applies_when, importance, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(mergedId, title, mergedBody, null, maxImportance, now);

      this.upsertProvenance(mergedId, [...sourceIds]);
      this.upsertTags(mergedId, "lesson", [...allTags]);
      this.upsertEntities(mergedId, "lesson", entities);

      for (const source of sources) {
        this.addEdgeSync({ srcId: mergedId, dstId: source.id, type: "merged_from", weight: 1, directed: true, createdAt: now });
        this.addEdgeSync({ srcId: mergedId, dstId: source.id, type: "supersedes", weight: 1, directed: true, createdAt: now });
        this.db.query("UPDATE lesson SET active = 0 WHERE id = ?").run(source.id);
        this.db
          .query("UPDATE memory_node SET invalid_at = ?, superseded_by = ? WHERE id = ?")
          .run(now, mergedId, source.id);
      }

      this.upsertSearchDoc({
        id: mergedId, kind: "lesson", title,
        body: mergedBody, outcome: null, updatedAt: now,
      });
    });
    txn();

    return { mergedId, kind: "lesson", sourceIds: sources.map((s) => s.id), supersededIds: sources.map((s) => s.id) };
  }

  async mergeFacts(ids: string[], title: string): Promise<MemoryMergeResult> {
    const now = Date.now();
    const mergedId = `fact_merged_${slug(title)}_${now}`;
    const idsJson = JSON.stringify(ids);

    const sources = this.db
      .query<
        { id: string; kind: string; title: string | null; body: string; confidence: number; importance: number; created_at: number },
        [string]
      >(
        `SELECT id, kind, title, body, confidence, importance, created_at
         FROM memory_fact WHERE id IN (SELECT value FROM json_each(?)) AND active = 1`,
      )
      .all(idsJson);

    if (sources.length === 0) throw new Error("No active facts found with the given IDs");

    const kindCounts = new Map<string, number>();
    for (const s of sources) kindCounts.set(s.kind, (kindCounts.get(s.kind) ?? 0) + 1);
    const dominantKind = [...kindCounts.entries()].sort((a, b) => b[1] - a[1])[0][0] as "curated_fact" | "routing_memory" | "procedure";

    const { sourceIds, allTags, allEntities } = this.collectMetadata(sources.map((s) => s.id));

    const mergedBody = [
      `Merged from: ${sources.map((s) => s.id).join(", ")}`,
      ...sources.map((s) => `---\n[${s.id}] ${s.title ?? s.kind}\n\n${s.body}`),
    ].join("\n\n");

    const maxImportance = Math.max(...sources.map((s) => s.importance));
    const maxConfidence = Math.max(...sources.map((s) => s.confidence));
    const minCreatedAt = Math.min(...sources.map((s) => s.created_at));
    const entities = [...allEntities.entries()].map(([name, kind]) => ({ name, kind }));
    const nodeKind: SearchableMemoryKind = dominantKind === "curated_fact" ? "fact" : dominantKind;

    const txn = this.db.transaction(() => {
      this.upsertNode(mergedId, nodeKind, minCreatedAt);
      this.db
        .query(
          `INSERT INTO memory_fact (id, kind, title, body, confidence, importance, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(mergedId, dominantKind, title, mergedBody, maxConfidence, maxImportance, now);

      this.upsertProvenance(mergedId, [...sourceIds]);
      this.upsertTags(mergedId, nodeKind, [...allTags]);
      this.upsertEntities(mergedId, nodeKind, entities);

      for (const source of sources) {
        this.addEdgeSync({ srcId: mergedId, dstId: source.id, type: "merged_from", weight: 1, directed: true, createdAt: now });
        this.addEdgeSync({ srcId: mergedId, dstId: source.id, type: "supersedes", weight: 1, directed: true, createdAt: now });
        this.db.query("UPDATE memory_fact SET active = 0 WHERE id = ?").run(source.id);
        this.db
          .query("UPDATE memory_node SET invalid_at = ?, superseded_by = ? WHERE id = ?")
          .run(now, mergedId, source.id);
      }

      this.upsertSearchDoc({
        id: mergedId, kind: nodeKind, title,
        body: mergedBody, outcome: null, updatedAt: now,
      });
    });
    txn();

    return { mergedId, kind: "fact", sourceIds: sources.map((s) => s.id), supersededIds: sources.map((s) => s.id) };
  }

  async archiveMemory(id: string): Promise<boolean> {
    const txn = this.db.transaction(() => {
      const eventResult = this.db.query("UPDATE memory_event SET active = 0 WHERE id = ? AND active = 1").run(id);
      const lessonResult = this.db.query("UPDATE lesson SET active = 0 WHERE id = ? AND active = 1").run(id);
      const factResult = this.db.query("UPDATE memory_fact SET active = 0 WHERE id = ? AND active = 1").run(id);
      return eventResult.changes + lessonResult.changes + factResult.changes;
    });
    return txn() > 0;
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

  async setRuleStatus(id: string, status: "accepted" | "rejected"): Promise<boolean> {
    const changed = this.db
      .query("UPDATE candidate_rule SET status = ? WHERE id = ?")
      .run(status, id);
    return changed.changes > 0;
  }

  async getAcceptedRules(): Promise<AcceptedRule[]> {
    return this.db
      .query<{ id: string; domain: string; rule_text: string }, []>(
        "SELECT id, domain, rule_text FROM candidate_rule WHERE status = 'accepted'",
      )
      .all()
      .map((row) => ({
        id: row.id,
        domain: row.domain as AcceptedRule["domain"],
        ruleText: row.rule_text,
      }));
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

    const results = [...candidates.values()]
      .filter((row) => this.recallFilter(row, options))
      .map((row) => this.toResult(row))
      .sort((a, b) => b.score - a.score)
      .filter(uniqueRecallResult())
      .slice(0, limit);
    if (options.recordUsage !== false) {
      this.recordRecallUsage(results.map((result) => result.id));
      this.logRecall(options, results);
    }
    return results;
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
        action: "archive",
        eventId: row.id,
        reason: "Archived old, low-importance, unused event from active recall set.",
        sourceIds: [row.source_record_id],
        now,
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
        action: "promote_routing_memory",
        eventId: eventIds[0],
        reason: `Promoted repeated correction (${group.count} examples) into routing memory.`,
        sourceIds: eventIds,
        now,
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
        action: "propose_rule",
        eventId: row.event_ids.split(",")[0],
        reason: "Proposed draft bounded-DSL rule from repeated tag corrections.",
        sourceIds: row.event_ids.split(","),
        now,
      });
      decisions.push(decision);
      proposedRuleIds.push(ruleId);
    }

    // --- Mark stale facts: unused facts older than 30 days ---
    const staleFactRows = this.db
      .query<{ id: string }, [number]>(
        `SELECT mf.id FROM memory_fact mf
         JOIN memory_node n ON n.id = mf.id
         WHERE mf.active = 1 AND mf.use_count = 0 AND mf.created_at < ?
           AND n.invalid_at IS NULL AND n.superseded_by IS NULL`,
      )
      .all(now - 30 * 24 * 60 * 60 * 1000);
    for (const row of staleFactRows) {
      this.db.query("UPDATE memory_fact SET active = 0 WHERE id = ?").run(row.id);
      const decision = this.recordDecision({
        action: "mark_stale",
        eventId: row.id,
        reason: "Fact unused for 30+ days, marked inactive.",
        sourceIds: [row.id],
        now,
      });
      decisions.push(decision);
      archivedEventIds.push(row.id);
    }

    // Do not promote tag-count clusters into lessons. A useful lesson must say
    // what to do differently and why; tag frequency alone is retrieval metadata.

    // --- Edge pruning: remove weak edges with no recent activity ---
    const edgePruneResult = this.db
      .query<{ count: number }, [number, number]>(
        `WITH linked_events AS (
           SELECT DISTINCT src_id AS node_id FROM edge
           UNION
           SELECT DISTINCT dst_id FROM edge
         ),
         prune_candidates AS (
           SELECT e.src_id, e.dst_id, e.type, e.weight
           FROM edge e
           WHERE e.weight < ? AND e.created_at < ?
             AND e.type NOT IN ('supersedes', 'lesson_from')
         )
         SELECT COUNT(*) AS count FROM prune_candidates`,
      )
      .get(0.3, now - 30 * 24 * 60 * 60 * 1000);
    if (edgePruneResult && edgePruneResult.count > 0) {
      this.db
        .query(
          `DELETE FROM edge WHERE weight < ? AND created_at < ?
           AND type NOT IN ('supersedes', 'lesson_from')`,
        )
        .run(0.3, now - 30 * 24 * 60 * 60 * 1000);
      const decision = this.recordDecision({
        action: "prune_edges",
        eventId: "",
        reason: `Pruned ${edgePruneResult.count} weak edges (weight < 0.3, older than 30 days).`,
        sourceIds: [],
        now,
      });
      decisions.push(decision);
    }

    // --- Thread summarization: create summaries for threads with recent activity ---
    const summaryThreads = this.db
      .query<{ thread_id: string; event_count: number; last_ts: number }, [number]>(
        `SELECT thread_id, COUNT(*) AS event_count, MAX(created_at) AS last_ts
         FROM memory_event
         WHERE active = 1 AND created_at > ?
         GROUP BY thread_id
         HAVING COUNT(*) >= 5`,
      )
      .all(now - 7 * 24 * 60 * 60 * 1000);
    for (const thread of summaryThreads) {
      const summaryId = `summary_${slug(thread.thread_id)}_${now}`;
      // Check if a recent summary already exists for this thread.
      const existing = this.db
        .query<{ id: string }, [string, number]>(
          "SELECT id FROM memory_search_doc WHERE kind = 'summary' AND id LIKE ? AND updated_at > ?",
        )
        .get(`summary_${slug(thread.thread_id)}_%`, now - 7 * 24 * 60 * 60 * 1000);
      if (existing) continue;

      // Build a simple extractive summary from event outcomes.
      const eventSamples = this.db
        .query<{ body: string; outcome: string | null }, [string, number]>(
          `SELECT body, outcome FROM memory_event
           WHERE thread_id = ? AND created_at > ?
           ORDER BY created_at DESC LIMIT 10`,
        )
        .all(thread.thread_id, now - 7 * 24 * 60 * 60 * 1000);
      const outcomes = eventSamples
        .map((e) => e.outcome)
        .filter(Boolean) as string[];
      const body = [
        `Thread ${thread.thread_id}: ${thread.event_count} events in the last 7 days.`,
        `Recent outcomes: ${outcomes.slice(0, 5).join(", ") || "none recorded"}.`,
        `Latest: ${eventSamples[0]?.body.slice(0, 200) ?? "no recent content"}`,
      ].join("\n");

      this.upsertNode(summaryId, "summary", now);
      this.db
        .query(
          `INSERT INTO memory_search_doc (id, kind, title, body, outcome, updated_at)
           VALUES (?, 'summary', ?, ?, NULL, ?)
           ON CONFLICT(id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
        )
        .run(summaryId, `Thread summary: ${thread.thread_id}`, body, now);
      const decision = this.recordDecision({
        action: "summarize",
        eventId: "",
        reason: `Created extractive summary for thread ${thread.thread_id} (${thread.event_count} events).`,
        sourceIds: [],
        now,
      });
      decisions.push(decision);
      promotedMemoryIds.push(summaryId);
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
      // Claims live in their own table (not memory_search_doc, to keep the
      // general recall() path clean) but their text is searchable via memory_fts.
      this.db.run(
        `INSERT INTO memory_fts (id, kind, title, body, outcome)
         SELECT id, 'claim', NULL, text, NULL FROM claim WHERE active = 1`,
      );
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
      this.syncClaimFts(claim.id, claim.text);
    });
    txn();
  }

  /**
   * BRUTE-FORCE COSINE recall over the claim corpus (rung 1 of the vector
   * ladder). Filters are the WHERE (they narrow candidates FIRST), the cosine
   * against a PRE-COMPUTED queryVector is the ORDER BY, and FTS is the
   * exact-identifier escape hatch. This method never embeds — the caller embeds
   * at the boundary. With no queryVector it falls back to FTS-only.
   */
  async recallClaims(options: ClaimRecallOptions): Promise<ClaimRecallResult[]> {
    const limit = options.limit ?? 5;
    const filters = options.filters ?? {};
    const queryVector = options.queryVector;
    const ftsQuery = options.ftsQuery?.trim();

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

    // 2. FTS match for the identifier tail — restricted to claims AND to the
    //    pre-filtered candidate set, normalized so the best hit scores 1.
    const candidateIds = new Set(rows.map((row) => row.id));
    const ftsNorm = new Map<string, number>();
    if (ftsQuery) {
      const hits = this.claimFtsHits(ftsQuery, limit * 8).filter((hit) =>
        candidateIds.has(hit.id),
      );
      if (hits.length > 0) {
        const positives = hits.map((hit) => -hit.rank); // bm25 negative → positive
        const maxPositive = Math.max(...positives, 1e-9);
        for (const hit of hits) ftsNorm.set(hit.id, -hit.rank / maxPositive);
      }
    }

    // 3. Cosine in TS, merged with the FTS signal, weighted by `weight`.
    const ftsWeight = 0.5;
    const scored = rows.map((row) => {
      const tags = row.tags ? (JSON.parse(row.tags) as string[]) : [];
      const weight = row.weight ?? 1;
      const vec = deserializeEmbedding(row.embedding);
      const cosine = queryVector && vec ? cosineSim(queryVector, vec) : null;
      const ftsMatched = ftsNorm.has(row.id);
      const ftsScore = ftsNorm.get(row.id) ?? 0;
      const base = queryVector ? (cosine ?? 0) + ftsWeight * ftsScore : ftsScore;
      return { row, tags, weight, cosine, ftsMatched, score: base * weight };
    });

    // FTS-only fallback: when there is no queryVector but an ftsQuery was given,
    // only lexical matches are relevant.
    const ranked = !queryVector && ftsQuery
      ? scored.filter((entry) => entry.ftsMatched)
      : scored;

    ranked.sort((a, b) => b.score - a.score);
    return ranked.slice(0, limit).map((entry) => ({
      id: entry.row.id,
      kind: entry.row.kind as ClaimKind,
      text: entry.row.text,
      repo: entry.row.repo,
      tags: entry.tags,
      weight: entry.weight,
      score: entry.score,
      cosine: entry.cosine,
      ftsMatched: entry.ftsMatched,
      sourceEpisode: entry.row.source_episode,
      helpfulCount: entry.row.helpful_count ?? 0,
      unhelpfulCount: entry.row.unhelpful_count ?? 0,
      createdAt: entry.row.created_at,
      lastUsedAt: entry.row.last_used_at,
    }));
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

  private syncClaimFts(id: string, text: string): void {
    this.db.query("DELETE FROM memory_fts WHERE id = ?").run(id);
    this.db
      .query(
        `INSERT INTO memory_fts (id, kind, title, body, outcome)
         VALUES (?, 'claim', NULL, ?, NULL)`,
      )
      .run(id, text);
  }

  private claimFtsHits(query: string, limit: number): Array<{ id: string; rank: number }> {
    return this.db
      .query<{ id: string; rank: number }, [string, number]>(
        `SELECT id, bm25(memory_fts) AS rank
         FROM memory_fts
         WHERE memory_fts MATCH ? AND kind = 'claim'
         ORDER BY rank
         LIMIT ?`,
      )
      .all(toFtsQuery(query), limit);
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

  /** Append-only provenance: adds source_ids without clearing existing. */
  private upsertProvenance(memoryId: string, sourceIds: string[]): void {
    if (sourceIds.length === 0) return;
    const insert = this.db.query(
      "INSERT OR IGNORE INTO memory_provenance (memory_id, source_id) VALUES (?, ?)",
    );
    for (const sourceId of sourceIds) insert.run(memoryId, sourceId);
  }

  /** Append-only tags: adds tags without clearing existing. */
  private upsertTags(memoryId: string, memoryKind: string, tags: string[]): void {
    if (tags.length === 0) return;
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

  /** Append-only entities: adds entities without clearing existing. */
  private upsertEntities(
    memoryId: string,
    memoryKind: string,
    entities: Array<{ name: string; kind: string }>,
  ): void {
    if (entities.length === 0) return;
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

  /** Collect union of tags, entities, and provenance across a set of memory IDs. */
  private collectMetadata(ids: string[]): {
    sourceIds: Set<string>;
    allTags: Set<string>;
    allEntities: Map<string, string>;
  } {
    const sourceIds = new Set<string>();
    const allTags = new Set<string>();
    const allEntities = new Map<string, string>();

    for (const id of ids) {
      const tagRows = this.db
        .query<{ tag_id: string }, [string]>(
          "SELECT tag_id FROM memory_tag WHERE memory_id = ?",
        )
        .all(id);
      for (const t of tagRows) {
        allTags.add(t.tag_id.replace(/^tag:/, ""));
      }

      const entityRows = this.db
        .query<{ entity_id: string }, [string]>(
          "SELECT entity_id FROM mention WHERE memory_id = ?",
        )
        .all(id);
      for (const e of entityRows) {
        const match = e.entity_id.match(/^entity:(.+):(.+)$/);
        if (match) allEntities.set(match[2], match[1]);
      }

      const provRows = this.db
        .query<{ source_id: string }, [string]>(
          "SELECT source_id FROM memory_provenance WHERE memory_id = ?",
        )
        .all(id);
      for (const p of provRows) sourceIds.add(p.source_id);
    }
    return { sourceIds, allTags, allEntities };
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
          ), edge_links(src_id, dst_id, weight) AS (
            SELECT src_id, dst_id, weight FROM edge
            UNION ALL
            SELECT dst_id, src_id, weight FROM edge WHERE directed = 0
          ), related(id, depth, score, path) AS (
            SELECT e.dst_id, 1, e.weight, e.src_id || '>' || e.dst_id
            FROM edge_links e JOIN seed s ON s.id = e.src_id
            UNION ALL
            SELECT e.dst_id, r.depth + 1, r.score * e.weight * 0.7, r.path || '>' || e.dst_id
            FROM edge_links e JOIN related r ON e.src_id = r.id
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
      score: row.activation + kindBoost(row.kind) + importance + frequency + recency,
      reasons: unique(row.reasons),
      sourceIds: row.source_ids ? row.source_ids.split(",").filter(Boolean) : [],
    };
  }

  /**
   * Append one row per production recall: the query/tags/entities/kinds that
   * came in, the caller's intent, and the ids we returned. This is the real
   * query log the design depends on — replaying these against future retrieval
   * changes is the only honest way to measure whether a change helps. Gated by
   * recordUsage so eval/replay reads never write here.
   */
  private logRecall(options: MemoryRecallOptions, results: MemorySearchResult[]): void {
    this.db
      .query(
        `INSERT INTO recall_log
           (query, tags_json, entities_json, kinds_json, caller_intent, returned_ids_json, result_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        options.query?.trim() || null,
        options.tags && options.tags.length ? JSON.stringify(options.tags) : null,
        options.entities && options.entities.length ? JSON.stringify(options.entities) : null,
        options.kinds && options.kinds.length ? JSON.stringify(options.kinds) : null,
        options.callerIntent ?? null,
        JSON.stringify(results.map((result) => result.id)),
        results.length,
        Date.now(),
      );
  }

  private recordRecallUsage(ids: string[]): void {
    const uniqueIds = unique(ids);
    if (uniqueIds.length === 0) return;
    const now = Date.now();
    const txn = this.db.transaction(() => {
      const bumpEvent = this.db.query(
        "UPDATE memory_event SET use_count = use_count + 1, last_used_at = ? WHERE id = ?",
      );
      const bumpLesson = this.db.query(
        "UPDATE lesson SET use_count = use_count + 1, last_used_at = ? WHERE id = ?",
      );
      const bumpFact = this.db.query(
        "UPDATE memory_fact SET use_count = use_count + 1, last_used_at = ? WHERE id = ?",
      );
      for (const id of uniqueIds) {
        bumpEvent.run(now, id);
        bumpLesson.run(now, id);
        bumpFact.run(now, id);
      }
    });
    txn();
  }

  private recordDecision(params: {
    action: ConsolidationDecisionRecord["action"];
    eventId: string;
    reason: string;
    sourceIds: string[];
    now: number;
  }): ConsolidationDecisionRecord {
    const id = `decision_${params.action}_${params.eventId}_${params.now}`;
    const decision: ConsolidationDecisionRecord = {
      id,
      eventId: params.eventId,
      action: params.action,
      reason: params.reason,
      sourceIds: params.sourceIds,
      extractor: "heuristic",
      createdAt: params.now,
    };
    this.db
      .query(
        `INSERT INTO consolidation_decision (id, event_id, action, reason, source_ids_json, extractor, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        decision.id, decision.eventId, decision.action, decision.reason,
        JSON.stringify(decision.sourceIds), decision.extractor, decision.createdAt,
      );
    return decision;
  }

  private migrate(): void {
    this.db.run(`CREATE TABLE IF NOT EXISTS memory_source_record (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('slack_message', 'runner_output', 'routing_decision', 'routing_correction', 'ingestion_correction', 'curated_fact', 'manual_correction')), channel_id TEXT, thread_id TEXT, slack_ts TEXT, source_url TEXT, actor_id TEXT, actor_kind TEXT CHECK (actor_kind IN ('human', 'junior', 'agent', 'bot', 'system')), agent_name TEXT, repo_name TEXT, body TEXT NOT NULL, metadata_json TEXT, created_at INTEGER NOT NULL)`);
    this.db.run(`CREATE TABLE IF NOT EXISTS memory_node (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('event', 'lesson', 'summary', 'fact', 'procedure', 'routing_memory', 'entity', 'tag', 'claim')), created_at INTEGER NOT NULL, valid_at INTEGER, invalid_at INTEGER, superseded_by TEXT)`);
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
    this.db.run(`CREATE TABLE IF NOT EXISTS recall_log (id INTEGER PRIMARY KEY AUTOINCREMENT, query TEXT, tags_json TEXT, entities_json TEXT, kinds_json TEXT, caller_intent TEXT, returned_ids_json TEXT NOT NULL, result_count INTEGER NOT NULL, created_at INTEGER NOT NULL)`);
    // memory v3: semantic claim store (text + embedding co-located) — mirrors the lesson/memory_node relationship.
    this.db.run(`CREATE TABLE IF NOT EXISTS claim (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('lesson', 'fact', 'situation-claim')), text TEXT NOT NULL, embedding BLOB, embed_model TEXT, dim INTEGER, repo TEXT, tags TEXT, source_episode TEXT, helpful_count INTEGER DEFAULT 0, unhelpful_count INTEGER DEFAULT 0, weight REAL DEFAULT 1.0, created_at INTEGER, last_used_at INTEGER, active INTEGER DEFAULT 1, FOREIGN KEY (id) REFERENCES memory_node(id))`);
    // memory v3: raw episodic log (affect sidecar over memory_source_record).
    this.db.run(`CREATE TABLE IF NOT EXISTS episode (id TEXT PRIMARY KEY, actor TEXT, subjects_json TEXT, what TEXT, emotion TEXT, intensity REAL, valence REAL, trigger TEXT, response TEXT, salience REAL, consolidated_into_json TEXT, created_at INTEGER NOT NULL, FOREIGN KEY (id) REFERENCES memory_source_record(id))`);
    this.db.run("CREATE INDEX IF NOT EXISTS edge_src_idx ON edge(src_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS edge_dst_idx ON edge(dst_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS edge_type_src_idx ON edge(type, src_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS memory_tag_tag_idx ON memory_tag(tag_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS mention_entity_idx ON mention(entity_id)");
    this.db.run("CREATE INDEX IF NOT EXISTS recall_log_created_idx ON recall_log(created_at)");
    this.db.run("CREATE INDEX IF NOT EXISTS claim_repo_idx ON claim(repo)");
    this.db.run("CREATE INDEX IF NOT EXISTS claim_kind_idx ON claim(kind)");
    this.db.run("CREATE INDEX IF NOT EXISTS claim_active_created_idx ON claim(active, created_at)");
    this.db.run("CREATE INDEX IF NOT EXISTS episode_created_idx ON episode(created_at)");
  }
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

function kindBoost(kind: SearchableMemoryKind): number {
  switch (kind) {
    case "procedure":
    case "routing_memory":
      return 2;
    case "fact":
      return 1.5;
    case "lesson":
      return 1;
    case "summary":
      return 0.2;
    case "event":
      return -0.8;
  }
}

function uniqueRecallResult(): (result: MemorySearchResult) => boolean {
  const seen = new Set<string>();
  return (result) => {
    const key = normalizeName(`${result.kind}:${result.title ?? ""}:${result.body}`);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values.filter(Boolean))];
}
