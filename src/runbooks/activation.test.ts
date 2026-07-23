import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import path from "node:path";
import {
  AGENT_IDENTITIES,
  registerAgentIdentity,
} from "../support/agents.ts";
import {
  clearRegistryForTests,
  loadRunbookRegistryFromDir,
  getRunbook,
} from "./registry.ts";
import { CatalogStore } from "./catalog-store.ts";
import {
  activateDefinition,
  deactivateDefinition,
  updateSubmodulePointer,
} from "./activation.ts";

const FIXTURE_DIR = path.join(import.meta.dir, "__fixtures__");

describe("activation", () => {
  let store: CatalogStore;

  beforeEach(async () => {
    registerAgentIdentity("db-executioner", {
      username: "DB Executioner",
      iconEmoji: ":database:",
    });
    clearRegistryForTests();
    await loadRunbookRegistryFromDir(FIXTURE_DIR, "private");
    store = new CatalogStore(":memory:");
  });

  afterEach(() => {
    delete AGENT_IDENTITIES["db-executioner"];
    clearRegistryForTests();
    store.close();
  });

  describe("activateDefinition", () => {
    it("returns ok with name, contentDigest, and catalogEntry", async () => {
      const result = await activateDefinition(
        "transfer-ai-roadmaps",
        store,
      );
      expect(result.ok).toBe(true);

      if (!result.ok) throw new Error("expected ok");
      expect(result.name).toBe("transfer-ai-roadmaps");
      expect(result.contentDigest).toMatch(/^[0-9a-f]+$/);
      expect(result.catalogEntry).toBeDefined();
      expect(result.catalogEntry.kind).toBe("runbook");
      expect(result.catalogEntry.name).toBe("transfer-ai-roadmaps");
      expect(result.catalogEntry.enabled).toBe(true);
      expect(result.catalogEntry.validationStatus).toBe("valid");
    });

    it("stores the entry in the catalogue", async () => {
      const result = await activateDefinition(
        "transfer-ai-roadmaps",
        store,
      );
      expect(result.ok).toBe(true);

      const entry = store.getCatalogEntry("runbook", "transfer-ai-roadmaps");
      expect(entry).not.toBeNull();
      expect(entry!.kind).toBe("runbook");
      expect(entry!.name).toBe("transfer-ai-roadmaps");
      expect(entry!.repo).toBe("junior-private-agents");
      expect(entry!.enabled).toBe(true);
      expect(entry!.schemaVersion).toBe(1);
      expect(entry!.contentDigest).toMatch(/^[0-9a-f]+$/);
      expect(entry!.validationStatus).toBe("valid");
      expect(entry!.validationErrors).toBeNull();
      // loadedAt should be a recent timestamp
      expect(entry!.loadedAt).toBeGreaterThan(0);
    });

    it("returns ok=false for unknown runbook name", async () => {
      const result = await activateDefinition("does-not-exist", store);
      expect(result.ok).toBe(false);

      if (result.ok) throw new Error("expected failure");
      expect(result.reason).toContain("does-not-exist");
      expect(result.reason).toContain("not found");
    });

    it("stores commitSha when option is provided", async () => {
      const sha = "deadbeef12345678";
      const result = await activateDefinition("transfer-ai-roadmaps", store, {
        commitSha: sha,
      });
      expect(result.ok).toBe(true);

      const entry = store.getCatalogEntry("runbook", "transfer-ai-roadmaps");
      expect(entry).not.toBeNull();
      expect(entry!.commitSha).toBe(sha);
    });
  });

  describe("deactivateDefinition", () => {
    it("deactivates an activated entry", async () => {
      await activateDefinition("transfer-ai-roadmaps", store);

      const deactivated = deactivateDefinition(
        "transfer-ai-roadmaps",
        store,
      );
      expect(deactivated).toBe(true);

      const entry = store.getCatalogEntry("runbook", "transfer-ai-roadmaps");
      expect(entry).not.toBeNull();
      expect(entry!.enabled).toBe(false);
    });

    it("returns false for unknown runbook", () => {
      const deactivated = deactivateDefinition("ghost-runbook", store);
      expect(deactivated).toBe(false);
    });
  });

  describe("updateSubmodulePointer", () => {
    it("returns ok with oldSha and newSha='(dry-run)' in dry-run mode", async () => {
      const result = await updateSubmodulePointer({ dryRun: true });
      expect(result.ok).toBe(true);

      if (!result.ok) throw new Error("expected ok");
      expect(typeof result.oldSha).toBe("string");
      expect(result.oldSha.length).toBeGreaterThan(0);
      expect(result.newSha).toBe("(dry-run)");
    });
  });
});
