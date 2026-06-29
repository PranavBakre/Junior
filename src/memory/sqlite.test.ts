import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "./sqlite.ts";

describe("SqliteMemoryStore", () => {
  let tmpDir: string;
  let store: SqliteMemoryStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "junior-memory-"));
    store = new SqliteMemoryStore(join(tmpDir, "memory.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("retrofits the memory_node.kind CHECK to allow 'claim' on a pre-v3 DB", async () => {
    const dir = mkdtempSync(join(tmpdir(), "junior-memnode-retrofit-"));
    const dbPath = join(dir, "old.db");
    // Build a DB with the OLD memory_node CHECK (no 'claim'), as live DBs have.
    const raw = new Database(dbPath);
    raw.run(
      `CREATE TABLE memory_node (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('event', 'lesson', 'summary', 'fact', 'procedure', 'routing_memory', 'entity', 'tag')), created_at INTEGER NOT NULL, valid_at INTEGER, invalid_at INTEGER, superseded_by TEXT)`,
    );
    raw.run("INSERT INTO memory_node (id, kind, created_at) VALUES ('n1', 'lesson', 1)");
    // Sanity: the old table rejects 'claim'.
    expect(() =>
      raw.run("INSERT INTO memory_node (id, kind, created_at) VALUES ('c0', 'claim', 1)"),
    ).toThrow();
    raw.close();

    // Opening the store runs migrate() → the retrofit rebuild.
    const s = new SqliteMemoryStore(dbPath);
    try {
      const db = (s as unknown as { db: Database }).db;
      const sql = (
        db.query("SELECT sql FROM sqlite_master WHERE name='memory_node'").get() as { sql: string }
      ).sql;
      expect(sql).toContain("'claim'");
      // Pre-existing rows survive the rebuild.
      expect(
        (db.query("SELECT kind FROM memory_node WHERE id='n1'").get() as { kind: string }).kind,
      ).toBe("lesson");
      // And a claim now upserts (writes a memory_node row with kind='claim').
      await s.upsertClaim({
        id: "c1",
        kind: "lesson",
        text: "claims now allowed",
        embedding: new Float32Array(640),
        embedModel: "hashing",
        dim: 640,
        tags: [],
        weight: 1,
        createdAt: 1,
        active: true,
      });
      expect(
        (db.query("SELECT kind FROM memory_node WHERE id='c1'").get() as { kind: string }).kind,
      ).toBe("claim");
    } finally {
      s.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates the source, node, event, edge, and FTS tables from the docs schema", () => {
    const db = (store as unknown as { db: Database }).db;
    const rows = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type IN ('table', 'index')",
      )
      .all();
    const names = new Set(rows.map((row) => row.name));

    expect(names.has("memory_source_record")).toBe(true);
    expect(names.has("memory_node")).toBe(true);
    expect(names.has("memory_event")).toBe(true);
    expect(names.has("edge")).toBe(true);
    expect(names.has("memory_search_doc")).toBe(true);
    expect(names.has("memory_fts")).toBe(true);
  });

  it("stores raw source records separately from derived events", async () => {
    const now = Date.now();
    await store.appendSourceRecord({
      id: "source-1",
      kind: "slack_message",
      channelId: "C1",
      threadId: "T1",
      slackTs: "123.456",
      actorId: "U1",
      actorKind: "human",
      body: "Prefer SQLite FTS before vector database memory.",
      createdAt: now,
    });
    await store.upsertEvent({
      id: "event-1",
      sourceRecordId: "source-1",
      threadId: "T1",
      body: "User decided Junior memory should start with SQLite FTS instead of vector DBs.",
      outcome: "architecture_direction",
      importance: 0.9,
      createdAt: now,
      sourceTs: "123.456",
    });

    const db = (store as unknown as { db: Database }).db;
    const source = db
      .query<{ body: string }, [string]>(
        "SELECT body FROM memory_source_record WHERE id = ?",
      )
      .get("source-1");
    const event = db
      .query<{ source_record_id: string; body: string }, [string]>(
        "SELECT source_record_id, body FROM memory_event WHERE id = ?",
      )
      .get("event-1");

    expect(source?.body).toContain("SQLite FTS");
    expect(event?.source_record_id).toBe("source-1");
    expect(event?.body).toContain("start with SQLite FTS");
  });

  it("keeps memory_search_doc authoritative while syncing FTS", async () => {
    const now = Date.now();
    await store.appendSourceRecord({
      id: "source-1",
      kind: "slack_message",
      threadId: "T1",
      body: "Dashboard means gx-admin-client for this user.",
      createdAt: now,
    });
    await store.upsertEvent({
      id: "event-1",
      sourceRecordId: "source-1",
      threadId: "T1",
      body: "User corrected dashboard to mean gx-admin-client.",
      outcome: "routing_correction",
      createdAt: now,
    });

    const results = await store.recall({ query: "dashboard gx-admin-client" });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("event-1");
    expect(results[0].reasons).toContain("FTS matched query \"dashboard gx-admin-client\"");
  });

  it("can rebuild the FTS index from memory_search_doc", async () => {
    const now = Date.now();
    await store.appendSourceRecord({
      id: "source-1",
      kind: "curated_fact",
      body: "PR URLs should route to review.",
      createdAt: now,
    });
    await store.upsertEvent({
      id: "event-1",
      sourceRecordId: "source-1",
      threadId: "T1",
      body: "Curated routing fact: PR URLs should route to review.",
      createdAt: now,
    });

    const db = (store as unknown as { db: Database }).db;
    db.run("DELETE FROM memory_fts");
    expect((await store.recall({ query: "PR review" }))).toEqual([]);

    await store.rebuildSearchIndex();

    const results = await store.recall({ query: "PR review" });
    expect(results.map((result) => result.id)).toEqual(["event-1"]);
  });

  it("recalls memories by tag, entity, and bounded edge traversal", async () => {
    const now = Date.now();
    await store.appendSourceRecord({
      id: "source-1",
      kind: "slack_message",
      body: "Memory architecture should stay local-first.",
      createdAt: now,
    });
    await store.upsertEvent({
      id: "event-1",
      sourceRecordId: "source-1",
      threadId: "T1",
      body: "Junior memory should use SQLite FTS before vector infrastructure.",
      tags: ["memory_architecture", "sqlite"],
      entities: [{ kind: "system", name: "Junior" }],
      importance: 0.9,
      createdAt: now,
    });
    await store.upsertLesson({
      id: "lesson-1",
      title: "Prefer local-first recall",
      body: "Start memory recall with SQLite FTS, tags, entities, and edges.",
      sourceIds: ["event-1"],
      tags: ["memory_architecture"],
      createdAt: now,
    });

    const byTag = await store.recall({ tags: ["memory architecture"], limit: 5 });
    expect(byTag.map((result) => result.id)).toContain("event-1");
    expect(byTag.map((result) => result.id)).toContain("lesson-1");

    const byEntity = await store.recall({ entities: ["junior"], limit: 5 });
    expect(byEntity.map((result) => result.id)).toContain("event-1");

    const related = await store.recall({ query: "vector", depth: 2, limit: 5 });
    const lesson = related.find((result) => result.id === "lesson-1");
    expect(lesson?.reasons).toContain("Related by edge traversal");
  });

  it("records recall usage for returned memories", async () => {
    const now = Date.now();
    await store.appendSourceRecord({
      id: "source-1",
      kind: "slack_message",
      body: "Dashboard means admin client.",
      createdAt: now,
    });
    await store.upsertEvent({
      id: "event-1",
      sourceRecordId: "source-1",
      threadId: "T1",
      body: "User corrected dashboard to mean gx-admin-client.",
      createdAt: now,
    });

    await store.recall({ query: "dashboard", limit: 5 });

    const db = (store as unknown as { db: Database }).db;
    const row = db
      .query<{ use_count: number; last_used_at: number | null }, [string]>(
        "SELECT use_count, last_used_at FROM memory_event WHERE id = ?",
      )
      .get("event-1");
    expect(row?.use_count).toBe(1);
    expect(row?.last_used_at).toBeNumber();
  });

  it("traverses undirected edges from either side", async () => {
    const now = Date.now();
    await store.appendSourceRecord({
      id: "source-1",
      kind: "slack_message",
      body: "Dashboard and admin client are related aliases.",
      createdAt: now,
    });
    await store.upsertEvent({
      id: "event-dashboard",
      sourceRecordId: "source-1",
      threadId: "T1",
      body: "dashboard alias",
      createdAt: now,
    });
    await store.upsertLesson({
      id: "lesson-admin",
      title: "Admin dashboard alias",
      body: "gx-admin-client is the admin dashboard.",
      createdAt: now,
    });
    await store.addEdge({
      srcId: "event-dashboard",
      dstId: "lesson-admin",
      type: "same_topic",
      directed: false,
      createdAt: now,
    });

    const related = await store.recall({ query: "gx-admin-client", depth: 1, limit: 5 });

    expect(related.map((result) => result.id)).toContain("event-dashboard");
  });

  it("stores facts and suppresses superseded facts from current recall", async () => {
    const now = Date.now();
    await store.upsertFact({
      id: "fact-old",
      kind: "routing_memory",
      title: "Old dashboard alias",
      body: "dashboard means gx-client-next",
      confidence: 0.7,
      createdAt: now - 1000,
      tags: ["repo_alias"],
    });
    await store.upsertFact({
      id: "fact-new",
      kind: "routing_memory",
      title: "Current dashboard alias",
      body: "dashboard means gx-admin-client",
      confidence: 0.9,
      createdAt: now,
      tags: ["repo_alias"],
    });
    await store.addEdge({
      srcId: "fact-new",
      dstId: "fact-old",
      type: "supersedes",
      createdAt: now,
    });

    const current = await store.recall({ query: "dashboard", limit: 5 });
    expect(current.map((result) => result.id)).toContain("fact-new");
    expect(current.map((result) => result.id)).not.toContain("fact-old");

    const historical = await store.recall({ query: "dashboard", includeInvalid: true, limit: 5 });
    expect(historical.map((result) => result.id)).toContain("fact-old");
  });

  it("keeps memory_node kind in sync when updating fact kind", async () => {
    const now = Date.now();
    await store.upsertFact({
      id: "fact-kind",
      kind: "curated_fact",
      title: "Review route",
      body: "PR requests should go to review.",
      createdAt: now,
    });

    await store.updateFact("fact-kind", { kind: "routing_memory" });

    const db = (store as unknown as { db: Database }).db;
    const node = db
      .query<{ kind: string }, [string]>(
        "SELECT kind FROM memory_node WHERE id = ?",
      )
      .get("fact-kind");
    const doc = db
      .query<{ kind: string }, [string]>(
        "SELECT kind FROM memory_search_doc WHERE id = ?",
      )
      .get("fact-kind");

    expect(node?.kind).toBe("routing_memory");
    expect(doc?.kind).toBe("routing_memory");
  });

  it("logs classifications and corrections for ingestion rule learning", async () => {
    const now = Date.now();
    await store.logClassification({
      eventId: "event-1",
      inputText: "dashboard CSS broken",
      extractedMentions: ["dashboard", "css"],
      assignedTags: ["frontend", "styling"],
      assignedEventTypes: ["bug"],
      createdEdges: [],
      extractor: "heuristic",
      confidence: 0.8,
      createdAt: now,
    });
    await store.logCorrection({
      eventId: "event-1",
      field: "tag",
      incorrectValue: "backend",
      correctValue: "frontend",
      correctedBy: "user",
      createdAt: now,
    });

    const db = (store as unknown as { db: Database }).db;
    const classification = db
      .query<{ assigned_tags_json: string }, [string]>(
        "SELECT assigned_tags_json FROM ingestion_classification WHERE event_id = ?",
      )
      .get("event-1");
    const correction = db
      .query<{ correct_value: string }, [string]>(
        "SELECT correct_value FROM ingestion_correction WHERE event_id = ?",
      )
      .get("event-1");

    expect(JSON.parse(classification!.assigned_tags_json)).toContain("frontend");
    expect(correction?.correct_value).toBe("frontend");
  });

  it("consolidates by archiving cold events, promoting routing memories, proposing draft rules, and pruning edges", async () => {
    const now = Date.now();
    const old = now - 60 * 24 * 60 * 60 * 1000;
    await store.appendSourceRecord({ id: "source-old", kind: "slack_message", body: "ok", createdAt: old });
    await store.upsertEvent({
      id: "event-old",
      sourceRecordId: "source-old",
      threadId: "T1",
      body: "User said ok.",
      importance: 0.1,
      createdAt: old,
    });

    // Repeated tags are retrieval metadata, not enough evidence for a lesson.
    const recent = now - 1000;
    await store.appendSourceRecord({ id: "src-a", kind: "slack_message", body: "auth middleware broken", createdAt: recent });
    await store.upsertEvent({
      id: "event-auth-1",
      sourceRecordId: "src-a",
      threadId: "T2",
      body: "auth middleware broken on /api/v2",
      tags: ["auth", "bug", "agent:default", "runner_tool_error", "gx_learnings"],
      importance: 0.8,
      createdAt: recent,
    });
    await store.appendSourceRecord({ id: "src-b", kind: "slack_message", body: "JWT token expired", createdAt: recent });
    await store.upsertEvent({
      id: "event-auth-2",
      sourceRecordId: "src-b",
      threadId: "T2",
      body: "JWT token expired after 5 min",
      tags: ["auth", "error", "agent:default", "runner_tool_error", "gx_learnings"],
      importance: 0.9,
      createdAt: recent,
    });
    await store.appendSourceRecord({ id: "src-c", kind: "runner_output", body: "fixed auth middleware", createdAt: recent });
    await store.upsertEvent({
      id: "event-auth-3",
      sourceRecordId: "src-c",
      threadId: "T2",
      body: "fixed auth middleware with token refresh",
      tags: ["auth", "agent:default", "runner_tool_error", "gx_learnings"],
      importance: 0.75,
      createdAt: recent,
    });

    // Edge pruning: add a weak old edge
    await store.addEdge({
      srcId: "event-old",
      dstId: "event-auth-1",
      type: "similar",
      weight: 0.1,
      createdAt: old,
    });

    await store.logCorrection({
      eventId: "event-a",
      field: "routing_fact",
      correctValue: "dashboard means gx-admin-client",
      correctedBy: "user",
      createdAt: now - 2,
    });
    await store.logCorrection({
      eventId: "event-b",
      field: "routing_fact",
      correctValue: "dashboard means gx-admin-client",
      correctedBy: "user",
      createdAt: now - 1,
    });
    await store.logCorrection({
      eventId: "event-c",
      field: "tag",
      correctValue: "frontend",
      correctedBy: "user",
      createdAt: now - 1,
    });
    await store.logCorrection({
      eventId: "event-d",
      field: "tag",
      correctValue: "frontend",
      correctedBy: "user",
      createdAt: now,
    });

    const result = await store.consolidate({ now, repeatedCorrectionThreshold: 2 });

    // Archive
    expect(result.archivedEventIds).toContain("event-old");
    expect(result.decisions.map((decision) => decision.action)).toContain("archive");

    // Route promotion
    expect(result.promotedMemoryIds).toContain("routing_memory_dashboard_means_gx-admin-client");
    expect(result.decisions.map((decision) => decision.action)).toContain("promote_routing_memory");

    // Rule proposal
    expect(result.proposedRuleIds).toContain("rule_tag_frontend");
    expect(result.decisions.map((decision) => decision.action)).toContain("propose_rule");

    expect(result.decisions.map((decision) => decision.action)).not.toContain("promote_lesson");
    expect(result.promotedMemoryIds).not.toContain(`lesson_tag:auth_${now}`);

    // Edge pruning (weak old edge removed)
    expect(result.decisions.map((decision) => decision.action)).toContain("prune_edges");

    // Routing memory recall
    const recalled = await store.recall({ query: "dashboard gx-admin-client", kinds: ["routing_memory"], limit: 5 });
    expect(recalled.map((memory) => memory.id)).toContain("routing_memory_dashboard_means_gx-admin-client");
  });

  it("keeps draft rules pending manual acceptance after consolidation", async () => {
    const now = Date.now();
    await store.logCorrection({
      eventId: "event-c",
      field: "tag",
      correctValue: "frontend",
      correctedBy: "user",
      createdAt: now - 1,
    });
    await store.logCorrection({
      eventId: "event-d",
      field: "tag",
      correctValue: "frontend",
      correctedBy: "user",
      createdAt: now,
    });

    await store.consolidate({ now, repeatedCorrectionThreshold: 2 });

    expect(await store.getAcceptedRules()).toEqual([]);
  });

  it("does not demote accepted rules when consolidation re-proposes the same rule", async () => {
    const now = Date.now();
    await store.logCorrection({
      eventId: "event-c",
      field: "tag",
      correctValue: "frontend",
      correctedBy: "user",
      createdAt: now - 1,
    });
    await store.logCorrection({
      eventId: "event-d",
      field: "tag",
      correctValue: "frontend",
      correctedBy: "user",
      createdAt: now,
    });

    await store.consolidate({ now, repeatedCorrectionThreshold: 2 });
    expect(await store.setRuleStatus("rule_tag_frontend", "accepted")).toBe(true);

    await store.consolidate({ now: now + 1, repeatedCorrectionThreshold: 2 });

    expect((await store.getAcceptedRules()).map((rule) => rule.id)).toContain("rule_tag_frontend");
  });

  it("ranks actionable derived memories above raw event matches", async () => {
    const now = Date.now();
    await store.appendSourceRecord({ id: "source-merge", kind: "slack_message", body: "can we merge now", createdAt: now });
    await store.upsertEvent({
      id: "event-merge",
      sourceRecordId: "source-merge",
      threadId: "T1",
      body: "can we merge now",
      importance: 0.9,
      createdAt: now,
    });
    await store.upsertFact({
      id: "procedure-merge",
      kind: "procedure",
      title: "Merge safely",
      body: "Before merge, verify approval, checks, target branch, and merge identity.",
      importance: 0.9,
      createdAt: now,
    });

    const results = await store.recall({ query: "merge", limit: 2 });

    expect(results[0].id).toBe("procedure-merge");
    expect(results.map((result) => result.id)).toContain("event-merge");
  });

  it("deduplicates identical imported lessons in recall", async () => {
    const now = Date.now();
    for (const id of ["lesson-dup-a", "lesson-dup-b"]) {
      await store.upsertLesson({
        id,
        title: "Parallel worktree builds",
        body: "Merge each worktree branch sequentially and resolve conflicts one branch at a time.",
        importance: 0.8,
        createdAt: now,
      });
    }

    const results = await store.recall({ query: "merge worktree conflicts", limit: 5 });

    expect(results.filter((result) => result.title === "Parallel worktree builds")).toHaveLength(1);
  });

  it("archives active memories through the store API", async () => {
    const now = Date.now();
    await store.upsertLesson({
      id: "lesson-trash",
      title: "Repeated pattern: tag:backend",
      body: "8 high-importance events share the tag \"tag:backend\".",
      importance: 0.9,
      createdAt: now,
    });

    expect(await store.archiveMemory("lesson-trash")).toBe(true);
    expect(await store.recall({ query: "backend", limit: 5 })).toEqual([]);
    expect((await store.recall({ query: "backend", includeInactive: true, limit: 5 })).map((result) => result.id)).toContain("lesson-trash");
  });

  it("accepts and rejects proposed rules, listing accepted rules", async () => {
    await store.proposeRule({
      id: "rule_tag_frontend",
      status: "draft",
      domain: "tag",
      ruleText: "tag(Event, frontend) :- mentions_corrected_value(Event, frontend).",
      positiveExampleIds: ["event-1"],
      negativeExampleIds: [],
      createdAt: Date.now(),
    });

    // Accept
    const accepted = await store.setRuleStatus("rule_tag_frontend", "accepted");
    expect(accepted).toBe(true);

    const rules = await store.getAcceptedRules();
    expect(rules.map((rule) => rule.id)).toContain("rule_tag_frontend");

    // Reject
    const rejected = await store.setRuleStatus("rule_tag_frontend", "rejected");
    expect(rejected).toBe(true);

    const after = await store.getAcceptedRules();
    expect(after.map((rule) => rule.id)).not.toContain("rule_tag_frontend");

    // Non-existent rule
    const missing = await store.setRuleStatus("nonexistent", "accepted");
    expect(missing).toBe(false);
  });

  it("accepted rules survive store close and reopen", async () => {
    const path = join(tmpDir, "memory.db");
    await store.proposeRule({
      id: "rule_tag_persist",
      status: "draft",
      domain: "tag",
      ruleText: "test",
      positiveExampleIds: [],
      negativeExampleIds: [],
      createdAt: Date.now(),
    });
    await store.setRuleStatus("rule_tag_persist", "accepted");
    // Close the original store, reopen a fresh instance on the same file.
    store.close();

    const reopened = new SqliteMemoryStore(path);
    try {
      const rules = await reopened.getAcceptedRules();
      expect(rules.map((rule) => rule.id)).toContain("rule_tag_persist");
    } finally {
      reopened.close();
    }
    // Reassign so afterEach cleans up the reopened instance.
    store = reopened;
  });

  it("creates the v3 claim and episode tables", () => {
    const db = (store as unknown as { db: Database }).db;
    const names = new Set(
      db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name),
    );
    expect(names.has("claim")).toBe(true);
    expect(names.has("episode")).toBe(true);
  });

  it("upserts a claim and round-trips its Float32 embedding through the BLOB", async () => {
    const now = Date.now();
    await store.upsertClaim({
      id: "claim-embed",
      kind: "lesson",
      text: "Prefer brute-force cosine before a vector database.",
      embedding: new Float32Array([0.25, -0.5, 0.75, 1]),
      embedModel: "harrier-270",
      repo: "junior",
      tags: ["memory", "vectors"],
      createdAt: now,
    });

    const db = (store as unknown as { db: Database }).db;
    const row = db
      .query<{ embedding: Uint8Array; dim: number; embed_model: string; tags: string }, [string]>(
        "SELECT embedding, dim, embed_model, tags FROM claim WHERE id = ?",
      )
      .get("claim-embed");
    expect(row?.dim).toBe(4);
    expect(row?.embed_model).toBe("harrier-270");
    expect(JSON.parse(row!.tags)).toEqual(["memory", "vectors"]);
    // Decode the little-endian BLOB back to floats.
    const buf = Buffer.from(row!.embedding);
    const decoded = Array.from({ length: buf.byteLength / 4 }, (_, i) => buf.readFloatLE(i * 4));
    expect(decoded[0]).toBeCloseTo(0.25, 5);
    expect(decoded[1]).toBeCloseTo(-0.5, 5);
    expect(decoded[2]).toBeCloseTo(0.75, 5);
    expect(decoded[3]).toBeCloseTo(1, 5);
  });

  it("ranks claims by cosine against a pre-computed query vector", async () => {
    const now = Date.now();
    await store.upsertClaim({
      id: "claim-aligned",
      kind: "fact",
      text: "aligned claim",
      embedding: new Float32Array([1, 0, 0, 0]),
      createdAt: now,
    });
    await store.upsertClaim({
      id: "claim-orthogonal",
      kind: "fact",
      text: "orthogonal claim",
      embedding: new Float32Array([0, 1, 0, 0]),
      createdAt: now,
    });

    const results = await store.recallClaims({
      queryVector: new Float32Array([1, 0, 0, 0]),
      filters: {},
      limit: 5,
    });

    expect(results.map((r) => r.id)).toEqual(["claim-aligned", "claim-orthogonal"]);
    expect(results[0].cosine).toBeCloseTo(1, 5);
    expect(results[1].cosine).toBeCloseTo(0, 5);
  });

  it("weights cosine by the claim weight", async () => {
    const now = Date.now();
    // Slightly lower cosine but much higher weight should win.
    await store.upsertClaim({
      id: "claim-light",
      kind: "fact",
      text: "light",
      embedding: new Float32Array([1, 0, 0, 0]),
      weight: 1,
      createdAt: now,
    });
    await store.upsertClaim({
      id: "claim-heavy",
      kind: "fact",
      text: "heavy",
      embedding: new Float32Array([0.9, 0.1, 0, 0]),
      weight: 3,
      createdAt: now,
    });

    const results = await store.recallClaims({
      queryVector: new Float32Array([1, 0, 0, 0]),
      filters: {},
      limit: 5,
    });
    expect(results[0].id).toBe("claim-heavy");
  });

  it("applies WHERE filters BEFORE cosine, narrowing candidates", async () => {
    const now = Date.now();
    // repoA candidate is orthogonal (low cosine); repoB candidate is aligned.
    await store.upsertClaim({
      id: "claim-repoA",
      kind: "fact",
      text: "repo a claim",
      embedding: new Float32Array([0, 1, 0, 0]),
      repo: "gx-backend",
      createdAt: now,
    });
    await store.upsertClaim({
      id: "claim-repoB",
      kind: "fact",
      text: "repo b claim",
      embedding: new Float32Array([1, 0, 0, 0]),
      repo: "gx-client-next",
      createdAt: now,
    });

    const results = await store.recallClaims({
      queryVector: new Float32Array([1, 0, 0, 0]),
      filters: { repo: "gx-backend" },
      limit: 5,
    });

    // Even though repoB is more aligned, the repo filter removes it from candidates.
    expect(results.map((r) => r.id)).toEqual(["claim-repoA"]);
  });

  it("filters claims by kind, tags, and sinceMs before ranking", async () => {
    const now = Date.now();
    await store.upsertClaim({ id: "c-old", kind: "fact", text: "old", repo: "r", tags: ["x"], createdAt: now - 10_000 });
    await store.upsertClaim({ id: "c-new-x", kind: "fact", text: "new x", repo: "r", tags: ["x"], createdAt: now });
    await store.upsertClaim({ id: "c-new-y", kind: "lesson", text: "new y", repo: "r", tags: ["y"], createdAt: now });

    const byKindTagRecency = await store.recallClaims({
      filters: { kind: "fact", tags: ["x"], sinceMs: now - 5_000 },
      limit: 5,
    });
    expect(byKindTagRecency.map((r) => r.id)).toEqual(["c-new-x"]);
  });

  it("falls back to FTS-only when no query vector is supplied", async () => {
    const now = Date.now();
    await store.upsertClaim({
      id: "claim-pr",
      kind: "fact",
      text: "Bug fixed in PR-4242 touching the auth middleware.",
      createdAt: now,
    });
    await store.upsertClaim({
      id: "claim-noise",
      kind: "fact",
      text: "Unrelated note about styling tokens.",
      createdAt: now,
    });

    const results = await store.recallClaims({ ftsQuery: "PR-4242", filters: {}, limit: 5 });

    expect(results.map((r) => r.id)).toEqual(["claim-pr"]);
    expect(results[0].ftsMatched).toBe(true);
    expect(results[0].cosine).toBeNull();
  });

  it("keeps claim FTS out of the general recall() path", async () => {
    const now = Date.now();
    await store.upsertClaim({
      id: "claim-isolated",
      kind: "fact",
      text: "Isolated claim mentioning gx-admin-client dashboard.",
      createdAt: now,
    });

    // The general recall() joins memory_search_doc, which claims never enter.
    const general = await store.recall({ query: "gx-admin-client dashboard", limit: 5 });
    expect(general.map((r) => r.id)).not.toContain("claim-isolated");

    // But claim-scoped FTS still finds it.
    const claims = await store.recallClaims({ ftsQuery: "gx-admin-client", filters: {}, limit: 5 });
    expect(claims.map((r) => r.id)).toContain("claim-isolated");
  });

  it("appends an episode plus its backing source record", async () => {
    const now = Date.now();
    await store.appendEpisode({
      id: "ep_20260628_a1",
      actor: "pranav:person",
      subjects: ["pranav:person", "junior:self"],
      what: "Pranav called me an idiot for bypassing the merge rules.",
      emotion: "frustration",
      intensity: 0.7,
      valence: -0.6,
      trigger: "auto-merged to main, skipping dev-first",
      response: "apologized, fixed flow",
      salience: 0.85,
      threadId: "T-merge",
      actorKind: "human",
      createdAt: now,
    });

    const db = (store as unknown as { db: Database }).db;
    const episode = db
      .query<{ actor: string; subjects_json: string; emotion: string; salience: number; what: string }, [string]>(
        "SELECT actor, subjects_json, emotion, salience, what FROM episode WHERE id = ?",
      )
      .get("ep_20260628_a1");
    const source = db
      .query<{ body: string; thread_id: string; kind: string }, [string]>(
        "SELECT body, thread_id, kind FROM memory_source_record WHERE id = ?",
      )
      .get("ep_20260628_a1");

    expect(episode?.actor).toBe("pranav:person");
    expect(JSON.parse(episode!.subjects_json)).toEqual(["pranav:person", "junior:self"]);
    expect(episode?.emotion).toBe("frustration");
    expect(episode?.salience).toBeCloseTo(0.85, 5);
    expect(source?.body).toContain("called me an idiot");
    expect(source?.thread_id).toBe("T-merge");
    expect(source?.kind).toBe("slack_message");
  });

  it("rebuilds claim FTS entries from the claim table", async () => {
    const now = Date.now();
    await store.upsertClaim({
      id: "claim-rebuild",
      kind: "fact",
      text: "Rebuildable claim about worktree isolation.",
      createdAt: now,
    });

    const db = (store as unknown as { db: Database }).db;
    db.run("DELETE FROM memory_fts");
    expect(await store.recallClaims({ ftsQuery: "worktree", filters: {}, limit: 5 })).toEqual([]);

    await store.rebuildSearchIndex();

    const results = await store.recallClaims({ ftsQuery: "worktree", filters: {}, limit: 5 });
    expect(results.map((r) => r.id)).toEqual(["claim-rebuild"]);
  });

  // --- memory v3: last-used & decay (§7.1) ---------------------------------

  const lastUsedOf = (id: string): number | null => {
    const db = (store as unknown as { db: Database }).db;
    return (
      db
        .query<{ last_used_at: number | null }, [string]>(
          "SELECT last_used_at FROM claim WHERE id = ?",
        )
        .get(id)?.last_used_at ?? null
    );
  };

  it("bumps claim.last_used_at on a genuine recall (recordUsage defaults true)", async () => {
    const created = Date.now() - 100_000;
    await store.upsertClaim({
      id: "claim-used",
      kind: "fact",
      text: "used claim",
      embedding: new Float32Array([1, 0, 0, 0]),
      createdAt: created,
    });
    expect(lastUsedOf("claim-used")).toBeNull();

    const before = Date.now();
    const results = await store.recallClaims({
      queryVector: new Float32Array([1, 0, 0, 0]),
      filters: {},
      limit: 5,
    });
    expect(results.map((r) => r.id)).toEqual(["claim-used"]);
    // The returned row carries the PRE-bump value (null on first recall).
    expect(results[0].lastUsedAt).toBeNull();
    // The DB now records the recall.
    const bumped = lastUsedOf("claim-used");
    expect(bumped).not.toBeNull();
    expect(bumped!).toBeGreaterThanOrEqual(before);
  });

  it("does NOT bump claim.last_used_at when recordUsage is false (eval/dashboard reads)", async () => {
    await store.upsertClaim({
      id: "claim-inspected",
      kind: "fact",
      text: "inspected claim",
      embedding: new Float32Array([1, 0, 0, 0]),
      createdAt: Date.now(),
    });

    const results = await store.recallClaims({
      queryVector: new Float32Array([1, 0, 0, 0]),
      filters: {},
      limit: 5,
      recordUsage: false,
    });
    expect(results.map((r) => r.id)).toEqual(["claim-inspected"]);
    // Inspection traffic must not pollute the fade signal.
    expect(lastUsedOf("claim-inspected")).toBeNull();
  });

  it("markEpisodesUsed bumps episode.last_used_at", async () => {
    const created = Date.now() - 50_000;
    await store.appendEpisode({ id: "ep-x", what: "x happened", createdAt: created });
    await store.appendEpisode({ id: "ep-y", what: "y happened", createdAt: created });

    const db = (store as unknown as { db: Database }).db;
    const read = (id: string) =>
      db
        .query<{ last_used_at: number | null }, [string]>(
          "SELECT last_used_at FROM episode WHERE id = ?",
        )
        .get(id)?.last_used_at ?? null;
    expect(read("ep-x")).toBeNull();

    await store.markEpisodesUsed(["ep-x"], 1_700_000_000_000);
    expect(read("ep-x")).toBe(1_700_000_000_000);
    // Untouched episode stays null.
    expect(read("ep-y")).toBeNull();
  });

  it("archiveStaleClaims archives only stale-AND-low-weight claims, keeping the row", async () => {
    const now = 10_000_000_000_000;
    const old = now - 200 * 24 * 60 * 60 * 1000; // well past the cutoff
    const fresh = now - 1000;
    // stale + low weight  -> archive
    await store.upsertClaim({ id: "c-stale-low", kind: "fact", text: "a", weight: 0.2, lastUsedAt: old, createdAt: old });
    // stale + high weight  -> keep (value survives age)
    await store.upsertClaim({ id: "c-stale-high", kind: "fact", text: "b", weight: 5, lastUsedAt: old, createdAt: old });
    // fresh + low weight   -> keep (not stale)
    await store.upsertClaim({ id: "c-fresh-low", kind: "fact", text: "c", weight: 0.2, lastUsedAt: fresh, createdAt: old });
    // never used + old created_at + low weight -> archive
    await store.upsertClaim({ id: "c-neverused-low", kind: "fact", text: "d", weight: 0.2, createdAt: old });

    const result = await store.archiveStaleClaims({
      olderThanMs: 90 * 24 * 60 * 60 * 1000,
      maxWeight: 0.5,
      now,
    });
    expect(result.archivedIds.sort()).toEqual(["c-neverused-low", "c-stale-low"]);

    const db = (store as unknown as { db: Database }).db;
    const activeOf = (id: string) =>
      db.query<{ active: number }, [string]>("SELECT active FROM claim WHERE id = ?").get(id)?.active;
    // ARCHIVED, not deleted — rows are still present with active = 0.
    expect(activeOf("c-stale-low")).toBe(0);
    expect(activeOf("c-neverused-low")).toBe(0);
    // survivors stay active.
    expect(activeOf("c-stale-high")).toBe(1);
    expect(activeOf("c-fresh-low")).toBe(1);
  });

  it("memoryHealth reports corpus stats and fade candidates per kind", async () => {
    const now = 10_000_000_000_000;
    const old = now - 200 * 24 * 60 * 60 * 1000;
    await store.upsertClaim({ id: "h-used", kind: "lesson", text: "used", weight: 1, lastUsedAt: old, createdAt: old });
    await store.upsertClaim({ id: "h-never", kind: "lesson", text: "never", weight: 0.1, createdAt: old });
    await store.upsertClaim({ id: "h-fact", kind: "fact", text: "fact", weight: 1, lastUsedAt: now, createdAt: now });
    await store.appendEpisode({ id: "h-ep", what: "ep", createdAt: old });

    const health = await store.memoryHealth({ now, olderThanMs: 90 * 24 * 60 * 60 * 1000, maxWeight: 0.5 });
    expect(health.generatedAt).toBe(now);
    const byKind = Object.fromEntries(health.kinds.map((k) => [k.kind, k]));

    expect(byKind.lesson.total).toBe(2);
    expect(byKind.lesson.neverUsed).toBe(1);
    expect(byKind.lesson.pctNeverUsed).toBeCloseTo(0.5, 5);
    expect(byKind.lesson.oldestLastUsedAt).toBe(old);
    // only h-never is both stale (never used, old created_at) AND low-weight.
    expect(byKind.lesson.fadeCandidates).toBe(1);

    expect(byKind.fact.total).toBe(1);
    expect(byKind.fact.neverUsed).toBe(0);
    expect(byKind.fact.fadeCandidates).toBe(0);

    expect(byKind.episode.total).toBe(1);
    expect(byKind.episode.neverUsed).toBe(1);
    expect(byKind.episode.fadeCandidates).toBe(0);
  });
});
