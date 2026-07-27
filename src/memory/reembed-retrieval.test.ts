import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  backupDatabase,
  deterministicRetrievalText,
  validateRewrites,
  type CorpusRow,
} from "./reembed-retrieval.ts";

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
});
