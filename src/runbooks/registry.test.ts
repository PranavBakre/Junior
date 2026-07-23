import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import path from "node:path";
import fs from "node:fs/promises";
import {
  clearRegistryForTests,
  getContentDigest,
  getRunbook,
  listRunbooks,
  loadRunbookRegistryFromDir,
  searchRunbooks,
} from "./registry.ts";
import {
  AGENT_IDENTITIES,
  registerAgentIdentity,
} from "../support/agents.ts";

const fixtureDir = path.join(import.meta.dir, "__fixtures__");
const tmpDir = path.join(import.meta.dir, "__registry_test");

const VALID_RUNBOOK = `---
schemaVersion: 1
name: test-runbook
description: A test runbook for registry tests
ownerAgent: build
intent:
  examples:
    - do a test thing
  excludes:
    - do something else
inputs:
  - name: target
    type: string
    required: true
risk: workspace-write
approval:
  required: false
capabilities:
  - mongo.read
verification:
  required: true
  assertions:
    - thing was done
tags:
  - test
  - registry
---

Do the test thing.`;

const SECOND_RUNBOOK = `---
schemaVersion: 1
name: second-runbook
description: A second test runbook for search testing
ownerAgent: review
intent:
  examples:
    - do a second thing
  excludes:
    - not this
risk: read-only
approval:
  required: false
capabilities:
  - mongo.read
verification:
  required: false
  assertions: []
tags:
  - search-test
  - readonly
---

Do the second thing.`;

describe("runbook registry", () => {
  beforeEach(async () => {
    registerAgentIdentity("db-executioner", {
      username: "DB Executioner",
      iconEmoji: ":database:",
    });
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    delete AGENT_IDENTITIES["db-executioner"];
    clearRegistryForTests();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe("load from directory", () => {
    it("loads the fixture file from a directory", async () => {
      const result = await loadRunbookRegistryFromDir(fixtureDir, "private");
      expect(result.loaded).toBeGreaterThanOrEqual(1);
      expect(result.errors).toBe(0);
    });

    it("loads runbooks from a temp directory", async () => {
      await Bun.write(path.join(tmpDir, "test-runbook.runbook.md"), VALID_RUNBOOK);

      const result = await loadRunbookRegistryFromDir(tmpDir, "private");
      expect(result.loaded).toBe(1);
      expect(result.errors).toBe(0);
    });
  });

  describe("getRunbook", () => {
    it("returns the loaded definition", async () => {
      await loadRunbookRegistryFromDir(fixtureDir, "private");

      const def = getRunbook("transfer-ai-roadmaps");
      expect(def).toBeDefined();
      expect(def!.name).toBe("transfer-ai-roadmaps");
      expect(def!.description).toContain("AI roadmap");
      expect(def!.ownerAgent).toBe("db-executioner");
    });

    it("returns undefined for unknown name", async () => {
      await loadRunbookRegistryFromDir(fixtureDir, "private");

      const def = getRunbook("nonexistent-runbook");
      expect(def).toBeUndefined();
    });
  });

  describe("getContentDigest", () => {
    it("returns the hex digest for a loaded runbook", async () => {
      await loadRunbookRegistryFromDir(fixtureDir, "private");

      const digest = getContentDigest("transfer-ai-roadmaps");
      expect(digest).toBeDefined();
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
    });

    it("returns undefined for unknown name", async () => {
      const digest = getContentDigest("nonexistent");
      expect(digest).toBeUndefined();
    });
  });

  describe("searchRunbooks", () => {
    beforeEach(async () => {
      await Bun.write(path.join(tmpDir, "test-runbook.runbook.md"), VALID_RUNBOOK);
      await Bun.write(path.join(tmpDir, "second-runbook.runbook.md"), SECOND_RUNBOOK);
      await loadRunbookRegistryFromDir(tmpDir, "private");
    });

    it("matches by query in name/description", () => {
      const results = searchRunbooks({ query: "test" });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((r) => r.name === "test-runbook")).toBe(true);
    });

    it("matches by query in description", () => {
      const results = searchRunbooks({ query: "second" });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some((r) => r.name === "second-runbook")).toBe(true);
    });

    it("filters by tags", () => {
      const results = searchRunbooks({ tags: ["search-test"] });
      expect(results.length).toBe(1);
      expect(results[0].name).toBe("second-runbook");
    });

    it("filters by ownerAgent", () => {
      const results = searchRunbooks({ ownerAgent: "review" });
      expect(results.length).toBe(1);
      expect(results[0].name).toBe("second-runbook");
    });

    it("filters by risk", () => {
      const results = searchRunbooks({ risk: "read-only" });
      expect(results.length).toBe(1);
      expect(results[0].name).toBe("second-runbook");
    });

    it("respects limit", () => {
      const results = searchRunbooks({ limit: 1 });
      expect(results.length).toBe(1);
    });

    it("returns empty for non-matching query", () => {
      const results = searchRunbooks({ query: "zzzzz-no-match-zzzzz" });
      expect(results).toEqual([]);
    });

    it("search results have the expected shape", () => {
      const results = searchRunbooks({ query: "test" });
      expect(results.length).toBeGreaterThanOrEqual(1);
      const r = results[0];
      expect(r).toHaveProperty("name");
      expect(r).toHaveProperty("description");
      expect(r).toHaveProperty("ownerAgent");
      expect(r).toHaveProperty("risk");
      expect(r).toHaveProperty("tags");
      expect(r).toHaveProperty("origin");
      expect(r).toHaveProperty("contentDigest");
    });
  });

  describe("listRunbooks", () => {
    it("returns all loaded runbooks", async () => {
      await Bun.write(path.join(tmpDir, "test-runbook.runbook.md"), VALID_RUNBOOK);
      await Bun.write(path.join(tmpDir, "second-runbook.runbook.md"), SECOND_RUNBOOK);
      await loadRunbookRegistryFromDir(tmpDir, "private");

      const all = listRunbooks();
      expect(all.length).toBe(2);
      const names = all.map((d) => d.name).sort();
      expect(names).toEqual(["second-runbook", "test-runbook"]);
    });

    it("returns empty when nothing is loaded", () => {
      const all = listRunbooks();
      expect(all).toEqual([]);
    });
  });

  describe("last-known-good behavior", () => {
    it("valid runbook survives overwrite with invalid content on reload", async () => {
      // First load: valid content
      await Bun.write(path.join(tmpDir, "test-runbook.runbook.md"), VALID_RUNBOOK);
      const r1 = await loadRunbookRegistryFromDir(tmpDir, "private");
      expect(r1.loaded).toBe(1);
      expect(r1.errors).toBe(0);

      const defBefore = getRunbook("test-runbook");
      expect(defBefore).toBeDefined();
      expect(defBefore!.description).toContain("test runbook");

      // Overwrite with invalid content (missing frontmatter)
      await Bun.write(
        path.join(tmpDir, "test-runbook.runbook.md"),
        "This has no frontmatter at all — totally invalid.",
      );

      // Reload — the invalid load should fail but the valid entry should survive
      const r2 = await loadRunbookRegistryFromDir(tmpDir, "private");
      expect(r2.errors).toBe(1);

      // The previously valid entry should still be in the registry
      const defAfter = getRunbook("test-runbook");
      expect(defAfter).toBeDefined();
      expect(defAfter!.description).toContain("test runbook");
    });
  });

  describe("clearRegistryForTests", () => {
    it("empties the registry", async () => {
      await Bun.write(path.join(tmpDir, "test-runbook.runbook.md"), VALID_RUNBOOK);
      await loadRunbookRegistryFromDir(tmpDir, "private");
      expect(listRunbooks().length).toBe(1);

      clearRegistryForTests();
      expect(listRunbooks().length).toBe(0);
    });
  });
});
