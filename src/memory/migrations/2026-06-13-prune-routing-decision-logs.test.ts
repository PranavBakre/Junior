import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteMemoryStore } from "../sqlite.ts";
import { pruneRoutingDecisionLogs } from "./2026-06-13-prune-routing-decision-logs.ts";

describe("pruneRoutingDecisionLogs migration", () => {
  let tmpDir: string;
  let store: SqliteMemoryStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "junior-migrate-prune-"));
    store = new SqliteMemoryStore(join(tmpDir, "memory.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function seedDecisionLog(sourceId: string, factId: string, agent: string): Promise<void> {
    const now = Date.now();
    // Reproduce the OLD double-write: raw source record + derived routing_memory fact.
    await store.appendSourceRecord({
      id: sourceId,
      kind: "routing_decision",
      channelId: "C1",
      threadId: "T1",
      slackTs: "123.000",
      actorId: "U1",
      actorKind: "system",
      agentName: agent,
      body: "Selected default via single-session.",
      createdAt: now,
    });
    await store.upsertFact({
      id: factId,
      kind: "routing_memory",
      title: `Routing decision: ${agent}`,
      body: "Selected default via single-session.",
      confidence: 0.7,
      importance: 0.4,
      createdAt: now,
      sourceIds: [sourceId],
      tags: ["routing_decision", `agent:${agent}`],
      entities: [{ kind: "agent", name: agent }],
    });
  }

  it("prunes all decision-log routing_memory nodes and leaves source records intact", async () => {
    const db = (store as unknown as { db: Database }).db;

    // Seed three decision-log facts.
    await seedDecisionLog("src_route_1", "routing_memory_decision_src_route_1", "default");
    await seedDecisionLog("src_route_2", "routing_memory_decision_src_route_2", "build");
    await seedDecisionLog("src_route_3", "routing_memory_decision_src_route_3", "frontend");

    // Seed one LEGITIMATE routing memory that must survive.
    await store.upsertFact({
      id: "routing_memory_outcomes_alias",
      kind: "routing_memory",
      title: "Learned routing: CSS → frontend",
      body: "CSS tasks should always route to frontend agent.",
      confidence: 0.9,
      importance: 0.8,
      createdAt: Date.now(),
      sourceIds: [],
      tags: ["routing_memory", "learned_correction"],
    });

    // Confirm initial state: 4 routing_memory facts exist.
    const beforeFacts = db
      .query<{ id: string }, []>("SELECT id FROM memory_fact WHERE kind = 'routing_memory'")
      .all();
    expect(beforeFacts.length).toBe(4);

    // Dry-run: no deletes should happen.
    const dryResult = pruneRoutingDecisionLogs(db, { apply: false });
    expect(dryResult.targetCount).toBe(3);
    expect(dryResult.memory_fact).toBe(3);
    expect(dryResult.memory_node).toBe(3);
    expect(dryResult.memory_search_doc).toBe(3);
    expect(dryResult.memory_fts).toBe(3);

    const afterDryFacts = db
      .query<{ id: string }, []>("SELECT id FROM memory_fact WHERE kind = 'routing_memory'")
      .all();
    expect(afterDryFacts.length).toBe(4); // unchanged

    // Apply prune.
    const applyResult = pruneRoutingDecisionLogs(db, { apply: true });
    expect(applyResult.targetCount).toBe(3);
    expect(applyResult.memory_fact).toBe(3);
    expect(applyResult.memory_node).toBe(3);
    expect(applyResult.memory_search_doc).toBe(3);
    expect(applyResult.memory_fts).toBe(3);

    // Decision-log routing_memory nodes are gone from recall.
    const recalledDecisions = await store.recall({ kinds: ["routing_memory"], limit: 10 });
    expect(recalledDecisions.every((m) => !m.id.startsWith("routing_memory_decision_"))).toBe(true);

    // Legitimate routing memory is still recalled.
    const recalledLegit = await store.recall({ query: "CSS frontend agent", limit: 5 });
    expect(recalledLegit.some((m) => m.id === "routing_memory_outcomes_alias")).toBe(true);

    // Raw source records for the decision logs are PRESERVED.
    const sourceRows = db
      .query<{ id: string; kind: string }, []>(
        "SELECT id, kind FROM memory_source_record WHERE kind = 'routing_decision'",
      )
      .all();
    expect(sourceRows.length).toBe(3);

    // memory_fts has no rows for pruned ids.
    for (const id of ["routing_memory_decision_src_route_1", "routing_memory_decision_src_route_2", "routing_memory_decision_src_route_3"]) {
      const ftsRow = db
        .query<{ id: string }, [string]>("SELECT id FROM memory_fts WHERE id = ?")
        .get(id);
      expect(ftsRow).toBeNull();

      const sdRow = db
        .query<{ id: string }, [string]>("SELECT id FROM memory_search_doc WHERE id = ?")
        .get(id);
      expect(sdRow).toBeNull();
    }
  });

  it("is idempotent: second run finds 0 targets", async () => {
    const db = (store as unknown as { db: Database }).db;

    await seedDecisionLog("src_idem_1", "routing_memory_decision_src_idem_1", "default");

    pruneRoutingDecisionLogs(db, { apply: true });

    const secondResult = pruneRoutingDecisionLogs(db, { apply: true });
    expect(secondResult.targetCount).toBe(0);
    expect(secondResult.memory_fact).toBe(0);
    expect(secondResult.memory_node).toBe(0);
  });
});
