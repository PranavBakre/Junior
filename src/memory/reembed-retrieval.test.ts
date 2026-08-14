import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  backupDatabase,
  addMissingLessonVariants,
  bindComposerRewrites,
  composerCheckpointMetadata,
  deterministicRetrievalText,
  isCompatibleComposerCheckpoint,
  validateRewrites,
  validComposerCheckpoint,
  type CorpusRow,
} from "./reembed-retrieval.ts";
import { HashingEmbeddingProvider } from "./embedding/hashing.ts";
import type { EmbeddingProvider } from "./embedding/types.ts";

function lessonRow(overrides: Partial<CorpusRow> = {}): CorpusRow {
  return {
    id: "lesson-1",
    kind: "lesson",
    text: "Branch safely\nCreate feature branches from main.",
    retrieval_text: null,
    lesson_title: "Branch safely",
    lesson_body: "Create feature branches from main.",
    applies_when: "Starting work in a new worktree",
    fact_title: null,
    fact_body: null,
    ...overrides,
  };
}

describe("retrieval corpus migration", () => {
  it("includes applies_when in a lesson's deterministic retrieval cue", () => {
    expect(deterministicRetrievalText(lessonRow())).toBe(
      "Use this lesson when: Starting work in a new worktree\nBranch safely Create feature branches from main.",
    );
  });

  it("keeps authoritative claim text when a legacy lesson row is stale", () => {
    expect(
      deterministicRetrievalText(
        lessonRow({
          text: "Current authoritative rule: branch from the verified base.",
          lesson_title: "Stale legacy title",
          lesson_body: "Stale legacy rule: branch from dev.",
        }),
      ),
    ).toBe(
      "Use this lesson when: Starting work in a new worktree\nCurrent authoritative rule: branch from the verified base.",
    );
  });

  it("requires a complete, unique, bounded rewrite set", () => {
    const sources = [
      { id: "a", sourceHash: "hash-a" },
      { id: "b", sourceHash: "hash-b" },
    ];
    expect(() =>
      validateRewrites(
        sources,
        [
          {
            id: "a",
            sourceHash: "hash-a",
            retrievalText: "When should I use A? Use A here.",
          },
          {
            id: "b",
            sourceHash: "hash-b",
            retrievalText: "When should I use B? Use B here.",
          },
        ],
      )
    ).not.toThrow();
    expect(() => validateRewrites(sources, [
      { id: "a", sourceHash: "hash-a", retrievalText: "Only A" },
    ])).toThrow("missing 1 active claims");
    expect(() =>
      validateRewrites([sources[0]!], [
        { id: "a", sourceHash: "hash-a", retrievalText: "first" },
        { id: "a", sourceHash: "hash-a", retrievalText: "second" },
      ])
    ).toThrow("duplicate claim id");
    expect(() =>
      validateRewrites([sources[0]!], [
        { id: "a", sourceHash: "stale", retrievalText: "stale" },
      ])
    ).toThrow("Stale source hash");
  });

  it("binds source hashes locally instead of trusting model output", () => {
    expect(
      bindComposerRewrites(
        [{ id: "a", sourceHash: "canonical" }],
        [{ id: "a", retrievalText: "When does A apply? Use A here." }],
      ),
    ).toEqual([
      {
        id: "a",
        sourceHash: "canonical",
        retrievalText: "When does A apply? Use A here.",
      },
    ]);
    expect(() =>
      bindComposerRewrites(
        [{ id: "a", sourceHash: "canonical" }],
        [{ id: "unknown", retrievalText: "Untrusted output" }],
      )
    ).toThrow("unknown claim id");
  });

  it("reuses only source-bound checkpoint rows after corpus changes", () => {
    const sources = [
      { id: "current", sourceHash: "hash-current" },
      { id: "changed", sourceHash: "hash-new" },
    ];
    expect(
      validComposerCheckpoint(sources, [
        {
          id: "current",
          sourceHash: "hash-current",
          retrievalText: "Keep this rewrite.",
        },
        {
          id: "changed",
          sourceHash: "hash-old",
          retrievalText: "Regenerate this rewrite.",
        },
        {
          id: "removed",
          sourceHash: "hash-removed",
          retrievalText: "Discard this rewrite.",
        },
      ]),
    ).toEqual([
      {
        id: "current",
        sourceHash: "hash-current",
        retrievalText: "Keep this rewrite.",
      },
    ]);
  });

  it("allows a bounded long-source exception without permitting expansion", () => {
    const source = {
      id: "dense",
      sourceHash: "hash-dense",
      retrievalText: "s".repeat(2_300),
    };
    expect(() =>
      validateRewrites(
        [source],
        [{
          id: "dense",
          sourceHash: "hash-dense",
          retrievalText: "r".repeat(2_300),
        }],
        2_500,
      )
    ).not.toThrow();
    expect(() =>
      validateRewrites(
        [source],
        [{
          id: "dense",
          sourceHash: "hash-dense",
          retrievalText: "r".repeat(2_301),
        }],
        2_500,
      )
    ).toThrow("exceeds 2300 characters");
  });

  it("measures the raw stored projection against the hard length limit", () => {
    expect(() =>
      validateRewrites(
        [{ id: "padded", sourceHash: "hash-padded" }],
        [{
          id: "padded",
          sourceHash: "hash-padded",
          retrievalText: `A${" ".repeat(2_500)}B`,
        }],
        2_500,
      )
    ).toThrow("exceeds 2500 characters");
  });

  it("invalidates checkpoints from a different model or cleanup recipe", () => {
    const expected = composerCheckpointMetadata("composer-2.5");
    expect(isCompatibleComposerCheckpoint(expected, expected)).toBe(true);
    expect(
      isCompatibleComposerCheckpoint(
        composerCheckpointMetadata("different-model"),
        expected,
      ),
    ).toBe(false);
    expect(
      isCompatibleComposerCheckpoint(
        { ...expected, recipeHash: "old-recipe" },
        expected,
      ),
    ).toBe(false);
    expect(isCompatibleComposerCheckpoint(null, expected)).toBe(false);
  });

  it("dry-runs read-only against a pre-retrieval_text schema", async () => {
    const root = mkdtempSync(join(tmpdir(), "junior-reembed-dry-"));
    const dbPath = join(root, "memory.db");
    const workDir = join(root, "work");
    const db = new Database(dbPath);
    try {
      db.run(
        "CREATE TABLE claim (id TEXT PRIMARY KEY, kind TEXT, text TEXT, active INTEGER)",
      );
      db.run(
        "CREATE TABLE lesson (id TEXT PRIMARY KEY, title TEXT, body TEXT, applies_when TEXT)",
      );
      db.run(
        "CREATE TABLE memory_fact (id TEXT PRIMARY KEY, title TEXT, body TEXT)",
      );
      db.query("INSERT INTO claim VALUES (?, ?, ?, ?)").run(
        "old-lesson",
        "lesson",
        "Old title\nOld body",
        1,
      );
      db.query("INSERT INTO lesson VALUES (?, ?, ?, ?)").run(
        "old-lesson",
        "Old title",
        "Old body",
        "Handling an old schema",
      );
    } finally {
      db.close();
    }

    try {
      const proc = Bun.spawn(
        [
          "bun",
          "run",
          "src/memory/reembed-retrieval.ts",
          "--db",
          dbPath,
          "--work-dir",
          workDir,
        ],
        { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
      );
      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode, stderr).toBe(0);

      const after = new Database(dbPath, { readonly: true });
      try {
        const columns = after
          .query<{ name: string }, []>("PRAGMA table_info(claim)")
          .all()
          .map((column) => column.name);
        expect(columns).not.toContain("retrieval_text");
        expect(
          after.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM claim").get()
            ?.count,
        ).toBe(1);
      } finally {
        after.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("backs up the pre-migration schema before retrieval_text is added", () => {
    const root = mkdtempSync(join(tmpdir(), "junior-reembed-backup-"));
    const dbPath = join(root, "memory.db");
    const backupPath = join(root, "backup.db");
    const db = new Database(dbPath);
    db.run(
      "CREATE TABLE claim (id TEXT PRIMARY KEY, kind TEXT, text TEXT, active INTEGER)",
    );
    db.close();
    try {
      backupDatabase(dbPath, backupPath);
      const backup = new Database(backupPath, { readonly: true });
      try {
        const columns = backup
          .query<{ name: string }, []>("PRAGMA table_info(claim)")
          .all()
          .map((column) => column.name);
        expect(columns).toEqual(["id", "kind", "text", "active"]);
      } finally {
        backup.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("repairs missing and stale lesson variants without requiring a legacy lesson row", async () => {
    const root = mkdtempSync(join(tmpdir(), "junior-missing-variants-"));
    const dbPath = join(root, "memory.db");
    const workDir = join(root, "work");
    const db = new Database(dbPath);
    db.run("CREATE TABLE claim (id TEXT PRIMARY KEY, kind TEXT, text TEXT, active INTEGER)");
    db.run("CREATE TABLE lesson (id TEXT PRIMARY KEY, title TEXT, body TEXT, applies_when TEXT)");
    db.run("CREATE TABLE claim_embedding (claim_id TEXT, variant INTEGER, retrieval_text TEXT, embedding BLOB, embed_model TEXT, dim INTEGER, PRIMARY KEY (claim_id, variant))");
    db.query("INSERT INTO claim VALUES (?, 'lesson', ?, 1)").run(
      "claim-only",
      "Use exact repository identity\nMatch owner and repository, not a local alias.",
    );
    db.query("INSERT INTO claim VALUES (?, 'lesson', ?, 1)").run(
      "legacy-backed",
      "Preserve work\nPreserve work before pruning.",
    );
    db.query("INSERT INTO lesson VALUES (?, ?, ?, ?)").run(
      "legacy-backed",
      "Preserve work",
      "Preserve work before pruning.",
      "Removing a worktree",
    );
    db.query("INSERT INTO claim VALUES (?, 'lesson', ?, 1)").run(
      "stale-legacy",
      "Current source\nUse the authoritative claim text.",
    );
    db.query("INSERT INTO lesson VALUES (?, ?, ?, ?)").run(
      "stale-legacy",
      "Old source",
      "Use obsolete legacy text.",
      "An obsolete situation",
    );
    db.query("INSERT INTO claim_embedding VALUES (?, 1, ?, ?, ?, ?)").run(
      "legacy-backed",
      "stale text",
      new Uint8Array([0, 0, 0, 0]),
      "old-model",
      1,
    );
    db.close();

    try {
      const provider = new HashingEmbeddingProvider();
      const first = await addMissingLessonVariants(dbPath, workDir, 2, provider);
      expect(first.pending).toBe(6);
      expect(first.published).toBe(6);
      expect(existsSync(first.backupPath)).toBe(true);

      const after = new Database(dbPath, { readonly: true });
      try {
        const rows = after.query<{
          claim_id: string;
          variant: number;
          retrieval_text: string;
          embed_model: string;
          dim: number;
        }, []>(
          "SELECT claim_id, variant, retrieval_text, embed_model, dim FROM claim_embedding ORDER BY claim_id, variant",
        ).all();
        expect(rows).toHaveLength(6);
        expect(rows.every((row) => row.embed_model === provider.model)).toBe(true);
        expect(rows.every((row) => row.dim === provider.dim)).toBe(true);
        expect(rows.find((row) => row.claim_id === "claim-only" && row.variant === 1)
          ?.retrieval_text).toContain("Use exact repository identity");
        expect(rows.find((row) => row.claim_id === "legacy-backed" && row.variant === 2)
          ?.retrieval_text).toContain("Removing a worktree");
        const repairedStale = rows.find((row) =>
          row.claim_id === "stale-legacy" && row.variant === 1
        )?.retrieval_text ?? "";
        expect(repairedStale).toContain("Current source");
        expect(repairedStale).not.toContain("Old source");
        expect(repairedStale).not.toContain("obsolete situation");
      } finally {
        after.close();
      }

      const second = await addMissingLessonVariants(dbPath, workDir, 2, provider);
      expect(second.pending).toBe(0);
      expect(second.published).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("aborts variant publication when a lesson changes during embedding", async () => {
    const root = mkdtempSync(join(tmpdir(), "junior-variant-race-"));
    const dbPath = join(root, "memory.db");
    const db = new Database(dbPath);
    db.run("CREATE TABLE claim (id TEXT PRIMARY KEY, kind TEXT, text TEXT, active INTEGER)");
    db.run("CREATE TABLE lesson (id TEXT PRIMARY KEY, title TEXT, body TEXT, applies_when TEXT)");
    db.run("CREATE TABLE claim_embedding (claim_id TEXT, variant INTEGER, retrieval_text TEXT, embedding BLOB, embed_model TEXT, dim INTEGER, PRIMARY KEY (claim_id, variant))");
    db.query("INSERT INTO claim VALUES ('changing', 'lesson', 'Original lesson', 1)").run();
    db.close();

    const hashing = new HashingEmbeddingProvider();
    let changed = false;
    const provider: EmbeddingProvider = {
      model: hashing.model,
      dim: hashing.dim,
      embed: async (texts, mode) => {
        if (!changed) {
          changed = true;
          const writer = new Database(dbPath);
          writer.query("UPDATE claim SET text = 'Changed lesson' WHERE id = 'changing'").run();
          writer.close();
        }
        return hashing.embed(texts, mode);
      },
    };

    try {
      await expect(addMissingLessonVariants(dbPath, join(root, "work"), 2, provider))
        .rejects.toThrow("Lesson changed while embedding: changing");
      const after = new Database(dbPath, { readonly: true });
      try {
        expect(after.query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM claim_embedding",
        ).get()?.count).toBe(0);
      } finally {
        after.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
