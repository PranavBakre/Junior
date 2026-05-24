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

    const results = await store.search("dashboard gx-admin-client");

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
    expect(await store.search("PR review")).toEqual([]);

    await store.rebuildSearchIndex();

    const results = await store.search("PR review");
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

  it("consolidates by archiving cold events, promoting routing memories, and proposing draft rules", async () => {
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

    expect(result.archivedEventIds).toContain("event-old");
    expect(result.promotedMemoryIds).toContain("routing_memory_dashboard_means_gx-admin-client");
    expect(result.proposedRuleIds).toContain("rule_tag_frontend");
    expect(result.decisions.map((decision) => decision.action)).toContain("archive");
    expect(result.decisions.map((decision) => decision.action)).toContain("promote_routing_memory");
    expect(result.decisions.map((decision) => decision.action)).toContain("propose_rule");

    const recalled = await store.recall({ query: "dashboard gx-admin-client", kinds: ["routing_memory"], limit: 5 });
    expect(recalled.map((memory) => memory.id)).toContain("routing_memory_dashboard_means_gx-admin-client");
  });
});
