import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMemoryCli } from "./cli.ts";
import { SqliteMemoryStore } from "./sqlite.ts";
import { HashingEmbeddingProvider } from "./embedding/hashing.ts";
import { ProfileStore } from "./profiles/store.ts";
import type { ConsolidationInvoke, ConsolidationOutput } from "./consolidation/types.ts";

// Never load real model weights in CLI tests: add-lesson/add-fact mirror a
// claim using the default embedder, so force the hashing provider here.
process.env.MEMORY_EMBED_PROVIDER = "hashing";

describe("memory CLI", () => {
  it("archive-stale is report-first and requires --apply", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "junior-memory-cli-"));
    const dbPath = join(tmpDir, "memory.db");
    const now = Date.now();
    try {
      const store = new SqliteMemoryStore(dbPath);
      await store.upsertClaim({
        id: "stale-cli",
        kind: "lesson",
        text: "old lesson",
        embedding: new Float32Array([1, 0, 0]),
        weight: 0.2,
        createdAt: now - 1000,
        lastUsedAt: now - 1000,
        skipDedup: true,
      });
      store.close();

      const dry = JSON.parse(await runMemoryCli([
        "archive-stale", "--db", dbPath, "--older-than-ms", "500", "--max-weight", "0.5", "--json",
      ])) as { candidateIds: string[]; archivedIds: string[]; applied: boolean };
      expect(dry.candidateIds).toEqual(["stale-cli"]);
      expect(dry.archivedIds).toEqual([]);
      expect(dry.applied).toBe(false);

      await expect(runMemoryCli([
        "archive-stale", "--db", dbPath, "--older-than-ms", "1", "--apply", "--json",
      ])).rejects.toThrow("threshold overrides are dry-run only");

      process.env.MEMORY_ARCHIVE_OLDER_THAN_MS = "500";
      process.env.MEMORY_ARCHIVE_MAX_WEIGHT = "0.5";
      const applied = JSON.parse(await runMemoryCli([
        "archive-stale", "--db", dbPath, "--apply", "--json",
      ])) as { archivedIds: string[]; applied: boolean };
      expect(applied.archivedIds).toEqual(["stale-cli"]);
      expect(applied.applied).toBe(true);
      delete process.env.MEMORY_ARCHIVE_OLDER_THAN_MS;
      delete process.env.MEMORY_ARCHIVE_MAX_WEIGHT;
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("add-lesson mirrors the lesson into the semantic claim store", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "junior-memory-cli-"));
    const dbPath = join(tmpDir, "memory.db");
    try {
      const out = await runMemoryCli([
        "add-lesson", "--db", dbPath, "--json",
        "--id", "lesson-claimed",
        "--title", "Always branch from main",
        "--body", "Feature branches must be created from main, not dev.",
        "--applies-when", "Starting implementation work in a fresh worktree.",
        "--importance", "0.8",
        "--tags", "git,workflow",
      ]);
      const parsed = JSON.parse(out) as { upserted: string; kind: string; claim: boolean };
      expect(parsed.upserted).toBe("lesson-claimed");
      expect(parsed.kind).toBe("lesson");
      expect(parsed.claim).toBe(true);

      // The lesson row landed in the legacy lesson table, and the claim mirror
      // landed in the claim store with an embedding.
      const store = new SqliteMemoryStore(dbPath);
      try {
        const db = (store as unknown as { db: import("bun:sqlite").Database }).db;
        const lessonRow = db
          .query("SELECT title, body FROM lesson WHERE id = 'lesson-claimed'")
          .get() as { title: string; body: string } | null;
        expect(lessonRow).not.toBeNull();
        expect(lessonRow!.title).toBe("Always branch from main");

        const claimRow = db
          .query("SELECT kind, retrieval_text, embedding, dim FROM claim WHERE id = 'lesson-claimed'")
          .get() as {
            kind: string;
            retrieval_text: string | null;
            embedding: Uint8Array | null;
            dim: number;
          } | null;
        expect(claimRow).not.toBeNull();
        expect(claimRow!.kind).toBe("lesson");
        expect(claimRow!.dim).toBe(640);
        expect(claimRow!.embedding).not.toBeNull();
        expect(claimRow!.retrieval_text).toContain(
          "What should I do in this situation: Starting implementation work in a fresh worktree?",
        );
        const variants = db
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM claim_embedding WHERE claim_id = 'lesson-claimed'",
          )
          .get();
        expect(variants?.count).toBe(3);
      } finally {
        store.close();
      }

      // The mirrored claim is recallable via semantic recall.
      const recall = await runMemoryCli(["recall-claims", "--db", dbPath, "--query", "branch from main", "--json"]);
      expect(JSON.parse(recall).results.map((r: { id: string }) => r.id)).toContain("lesson-claimed");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("recall-claims --query embeds the text in-process and recalls semantically", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "junior-memory-cli-"));
    const dbPath = join(tmpDir, "memory.db");
    try {
      await runMemoryCli([
        "add-lesson", "--db", dbPath, "--json",
        "--id", "lesson-q",
        "--title", "Always branch from main",
        "--body", "Feature branches must be created from main, not dev.",
      ]);
      // No --query-vector; --query is embedded by the CLI (hashing provider here).
      const out = await runMemoryCli([
        "recall-claims", "--db", dbPath, "--query", "branch from main not dev", "--json",
      ]);
      expect(JSON.parse(out).results.map((r: { id: string }) => r.id)).toContain("lesson-q");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("add-fact mirrors the fact into the semantic claim store", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "junior-memory-cli-"));
    const dbPath = join(tmpDir, "memory.db");
    try {
      const out = await runMemoryCli([
        "add-fact", "--db", dbPath, "--json",
        "--id", "fact-claimed", "--kind", "routing_memory",
        "--title", "Frontend routing",
        "--body", "Frontend requests route to gx-client-next.",
        "--tags", "routing",
      ]);
      const parsed = JSON.parse(out) as { upserted: string; kind: string; claim: boolean };
      expect(parsed.upserted).toBe("fact-claimed");
      expect(parsed.kind).toBe("routing_memory");
      expect(parsed.claim).toBe(true);

      const store = new SqliteMemoryStore(dbPath);
      try {
        const db = (store as unknown as { db: import("bun:sqlite").Database }).db;
        const factRow = db
          .query("SELECT kind, body FROM memory_fact WHERE id = 'fact-claimed'")
          .get() as { kind: string; body: string } | null;
        expect(factRow).not.toBeNull();
        expect(factRow!.kind).toBe("routing_memory");

        const claimRow = db
          .query("SELECT kind FROM claim WHERE id = 'fact-claimed'")
          .get() as { kind: string } | null;
        expect(claimRow).not.toBeNull();
        expect(claimRow!.kind).toBe("fact");
      } finally {
        store.close();
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("recalls procedure memories by their original subtype", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "junior-memory-cli-"));
    const dbPath = join(tmpDir, "memory.db");
    try {
      await runMemoryCli([
        "add-fact", "--db", dbPath, "--json",
        "--id", "procedure-cleanup", "--kind", "procedure",
        "--title", "Clean merged worktrees",
        "--body", "Verify the branch is merged before removing its worktree.",
      ]);
      await runMemoryCli([
        "add-fact", "--db", dbPath, "--json",
        "--id", "fact-cleanup", "--kind", "curated_fact",
        "--body", "Worktrees live under the project worktrees directory.",
      ]);

      const output = await runMemoryCli([
        "recall-claims", "--db", dbPath,
        "--query", "clean merged worktrees", "--kind", "procedure", "--json",
      ]);
      const parsed = JSON.parse(output) as {
        results: Array<{ id: string; kind: string; factKind?: string | null }>;
      };

      expect(parsed.results.map((result) => result.id)).toEqual([
        "procedure-cleanup",
      ]);
      expect(parsed.results[0]).toMatchObject({
        kind: "fact",
        factKind: "procedure",
      });
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("adds a claim and recalls it from the configured db", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "junior-memory-cli-"));
    const dbPath = join(tmpDir, "memory.db");
    const store = new SqliteMemoryStore(dbPath);
    try {
      // No --embedding: the CLI embeds via the provider before calling the store,
      // because the store rejects an unguardable, cosine-invisible row.
      await runMemoryCli([
        "add-claim", "--db", dbPath,
        "--id", "claim-cli", "--kind", "fact",
        "--text", "Worktrees isolate target repos per thread.",
        "--repo", "junior", "--tags", "worktrees,isolation", "--json",
      ]);

      // No query vector → recallClaims ranks by weight and returns the claim;
      // cosine is null because the RECALL supplied no query vector.
      const output = await runMemoryCli(["recall-claims", "--db", dbPath, "--json"]);
      const parsed = JSON.parse(output) as { results: Array<{ id: string; cosine: number | null }> };
      expect(parsed.results.map((r) => r.id)).toContain("claim-cli");
      expect(parsed.results[0].cosine).toBeNull();
    } finally {
      store.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("add-claim creates all lesson retrieval variants", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "junior-memory-cli-"));
    const dbPath = join(tmpDir, "memory.db");
    try {
      await runMemoryCli([
        "add-claim", "--db", dbPath, "--json",
        "--id", "lesson-direct", "--kind", "lesson",
        "--text", "Verify the exact branch\nMatch the reviewed head before merging.",
      ]);

      const store = new SqliteMemoryStore(dbPath);
      try {
        const db = (store as unknown as { db: import("bun:sqlite").Database }).db;
        const variants = db.query<{ variant: number }, []>(
          "SELECT variant FROM claim_embedding WHERE claim_id = 'lesson-direct' ORDER BY variant",
        ).all();
        expect(variants.map((row) => row.variant)).toEqual([0, 1, 2]);
      } finally {
        store.close();
      }

      await expect(runMemoryCli([
        "add-claim", "--db", dbPath,
        "--id", "lesson-explicit", "--kind", "lesson",
        "--text", "Do not create partial lesson embeddings.",
        "--embedding", "1,0,0,0",
      ])).rejects.toThrow("use add-lesson instead");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("ranks claims by a pre-computed query vector from the configured db", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "junior-memory-cli-"));
    const dbPath = join(tmpDir, "memory.db");
    const store = new SqliteMemoryStore(dbPath);
    try {
      await runMemoryCli(["add-claim", "--db", dbPath, "--id", "claim-aligned", "--kind", "fact", "--text", "aligned", "--embedding", "1,0,0,0", "--json"]);
      await runMemoryCli(["add-claim", "--db", dbPath, "--id", "claim-ortho", "--kind", "fact", "--text", "ortho", "--embedding", "0,1,0,0", "--json"]);

      const output = await runMemoryCli(["recall-claims", "--db", dbPath, "--query-vector", "1,0,0,0", "--json"]);
      const parsed = JSON.parse(output) as { results: Array<{ id: string }> };
      expect(parsed.results.map((r) => r.id)).toEqual(["claim-aligned", "claim-ortho"]);
    } finally {
      store.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // --- claim dedup write guard on the CLI writers ---------------------------

  it("add-lesson merges a reworded lesson into the claim it already stored", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "junior-memory-cli-"));
    const dbPath = join(tmpDir, "memory.db");
    try {
      await runMemoryCli([
        "add-lesson", "--db", dbPath, "--json",
        "--id", "lesson-dedup-a",
        "--title", "Always branch from main",
        "--body", "Feature branches must be created from main, not dev.",
      ]);
      // A near-identical lesson under a DIFFERENT id — this used to add a twin
      // claim, because only consolidation ever ran the cosine gate.
      const out = await runMemoryCli([
        "add-lesson", "--db", dbPath, "--json",
        "--id", "lesson-dedup-b",
        "--title", "Always branch from main",
        "--body", "Feature branches must be created from main, and not from dev.",
      ]);
      const parsed = JSON.parse(out) as { claimAction: string; claimId: string };
      expect(parsed.claimAction).toBe("merged");
      expect(parsed.claimId).toBe("lesson-dedup-a");

      const store = new SqliteMemoryStore(dbPath);
      try {
        // The legacy lesson row is still written under its own id — only the
        // semantic claim collapsed.
        const lessons = (store as unknown as { db: import("bun:sqlite").Database }).db
          .query("SELECT id FROM lesson ORDER BY id")
          .all() as Array<{ id: string }>;
        expect(lessons.map((r) => r.id)).toEqual(["lesson-dedup-a", "lesson-dedup-b"]);
        expect(await store.exportClaimVectors()).toHaveLength(1);
      } finally {
        store.close();
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("add-claim merges a near-duplicate, and --skip-dedup writes it verbatim", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "junior-memory-cli-"));
    const dbPath = join(tmpDir, "memory.db");
    const store = new SqliteMemoryStore(dbPath);
    try {
      await runMemoryCli([
        "add-claim", "--db", dbPath, "--json",
        "--id", "c-guard-a", "--kind", "fact",
        "--text", "aligned", "--embedding", "1,0,0,0",
      ]);
      const merged = await runMemoryCli([
        "add-claim", "--db", dbPath, "--json",
        "--id", "c-guard-b", "--kind", "fact",
        "--text", "aligned too", "--embedding", "0.95,0.05,0,0",
      ]);
      expect(JSON.parse(merged)).toMatchObject({ upserted: "c-guard-a", action: "merged" });

      // --skip-dedup is the restore hatch: the same near-duplicate goes in as-is.
      const verbatim = await runMemoryCli([
        "add-claim", "--db", dbPath, "--json", "--skip-dedup",
        "--id", "c-guard-c", "--kind", "fact",
        "--text", "aligned again", "--embedding", "0.97,0.03,0,0",
      ]);
      expect(JSON.parse(verbatim)).toMatchObject({ upserted: "c-guard-c", action: "inserted" });
      expect(await store.exportClaimVectors()).toHaveLength(2);
    } finally {
      store.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("dedup-sweep dry-runs by default and archives only with --apply", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "junior-memory-cli-"));
    const dbPath = join(tmpDir, "memory.db");
    const store = new SqliteMemoryStore(dbPath);
    try {
      // Seed the pre-guard corpus state: two near-identical claims, both active.
      for (const [id, vec, weight] of [
        ["sweep-keep", "1,0,0,0", "5"],
        ["sweep-dup", "0.95,0.05,0,0", "1"],
      ] as const) {
        await runMemoryCli([
          "add-claim", "--db", dbPath, "--json", "--skip-dedup",
          "--id", id, "--kind", "lesson", "--text", `text ${id}`,
          "--embedding", vec, "--weight", weight,
        ]);
      }

      const dry = JSON.parse(await runMemoryCli(["dedup-sweep", "--db", dbPath, "--json"]));
      expect(dry).toMatchObject({ applied: false, duplicatesFound: 1, duplicatesArchived: 0 });
      expect(await store.exportClaimVectors()).toHaveLength(2);

      const applied = JSON.parse(
        await runMemoryCli(["dedup-sweep", "--db", dbPath, "--apply", "--json"]),
      );
      expect(applied).toMatchObject({ applied: true, duplicatesArchived: 1 });
      const survivors = await store.exportClaimVectors();
      expect(survivors.map((c) => c.id)).toEqual(["sweep-keep"]);
    } finally {
      store.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("runs v3 consolidation per-thread with an injected invoke + hashing embedder", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "junior-memory-cli-"));
    const dbPath = join(tmpDir, "memory.db");
    const store = new SqliteMemoryStore(dbPath);
    try {
      const now = Date.now();
      await store.appendSourceRecord({
        id: "src-v3-1",
        kind: "slack_message",
        threadId: "T-v3",
        actorId: "U_PRANAV",
        actorKind: "human",
        body: "Pranav: always go dev-first, never auto-merge to main",
        createdAt: now,
      });

      const output: ConsolidationOutput = {
        episodes: [],
        profiles: [],
        claims: [{ kind: "lesson", text: "Go dev-first; never auto-merge straight to main." }],
      };
      const invoke: ConsolidationInvoke = async () => output;
      const embedder = new HashingEmbeddingProvider(640);
      const profileStore = new ProfileStore({ root: join(tmpDir, "profiles") });

      const out = await runMemoryCli(
        ["consolidate-v3", "--db", dbPath, "--json"],
        { invoke, embedder, profileStore },
      );
      const parsed = JSON.parse(out) as {
        reports: Array<{ threadIds: string[]; report: { skipped: boolean; recordsProcessed?: number; claimsWritten?: number } }>;
      };

      const threaded = parsed.reports.find((r) => r.threadIds.includes("T-v3"));
      expect(threaded).toBeDefined();
      expect(threaded!.report.skipped).toBe(false);
      expect(threaded!.report.recordsProcessed).toBe(1);
      expect(threaded!.report.claimsWritten).toBe(1);

      // The claim was actually persisted.
      const vectors = await store.exportClaimVectors();
      expect(vectors).toHaveLength(1);

      // A second pass has nothing left to consolidate.
      const second = await runMemoryCli(
        ["consolidate-v3", "--db", dbPath, "--json"],
        { invoke, embedder, profileStore },
      );
      const secondParsed = JSON.parse(second) as { reports: Array<{ report: { skipped: boolean } }> };
      expect(secondParsed.reports.every((r) => r.report.skipped)).toBe(true);
    } finally {
      store.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("reports skipped when there are no unconsolidated records for v3", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "junior-memory-cli-"));
    const dbPath = join(tmpDir, "memory.db");
    const store = new SqliteMemoryStore(dbPath);
    try {
      const invoke: ConsolidationInvoke = async () => ({ episodes: [], profiles: [], claims: [] });
      const out = await runMemoryCli(
        ["consolidate-v3", "--db", dbPath, "--json"],
        { invoke, embedder: new HashingEmbeddingProvider(640), profileStore: new ProfileStore({ root: join(tmpDir, "profiles") }) },
      );
      const parsed = JSON.parse(out) as { reports: Array<{ report: { skipped: boolean } }> };
      expect(parsed.reports).toHaveLength(1);
      expect(parsed.reports[0].report.skipped).toBe(true);
    } finally {
      store.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
