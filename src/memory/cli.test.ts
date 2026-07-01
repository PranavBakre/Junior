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
  it("add-lesson mirrors the lesson into the semantic claim store", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "junior-memory-cli-"));
    const dbPath = join(tmpDir, "memory.db");
    try {
      const out = await runMemoryCli([
        "add-lesson", "--db", dbPath, "--json",
        "--id", "lesson-claimed",
        "--title", "Always branch from main",
        "--body", "Feature branches must be created from main, not dev.",
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
          .query("SELECT kind, embedding, dim FROM claim WHERE id = 'lesson-claimed'")
          .get() as { kind: string; embedding: Uint8Array | null; dim: number } | null;
        expect(claimRow).not.toBeNull();
        expect(claimRow!.kind).toBe("lesson");
        expect(claimRow!.dim).toBe(640);
        expect(claimRow!.embedding).not.toBeNull();
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

  it("adds a claim and recalls it from the configured db", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "junior-memory-cli-"));
    const dbPath = join(tmpDir, "memory.db");
    const store = new SqliteMemoryStore(dbPath);
    try {
      await runMemoryCli([
        "add-claim", "--db", dbPath,
        "--id", "claim-cli", "--kind", "fact",
        "--text", "Worktrees isolate target repos per thread.",
        "--repo", "junior", "--tags", "worktrees,isolation", "--json",
      ]);

      // No query vector → recallClaims ranks by weight and returns the claim;
      // cosine is null because nothing was embedded.
      const output = await runMemoryCli(["recall-claims", "--db", dbPath, "--json"]);
      const parsed = JSON.parse(output) as { results: Array<{ id: string; cosine: number | null }> };
      expect(parsed.results.map((r) => r.id)).toContain("claim-cli");
      expect(parsed.results[0].cosine).toBeNull();
    } finally {
      store.close();
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
