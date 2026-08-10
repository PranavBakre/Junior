import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import path from "node:path";
import {
  AGENT_IDENTITIES,
  registerAgentIdentity,
} from "../support/agents.ts";
import { CatalogStore } from "./catalog-store.ts";
import { clearRegistryForTests } from "./registry.ts";
import { bootstrapRunbookRuntime } from "./runtime.ts";
import { selectRunbook } from "./selector.ts";

const FIXTURE_DIR = path.join(import.meta.dir, "__fixtures__");

describe("runbook runtime cold start", () => {
  let store: CatalogStore;

  beforeEach(() => {
    registerAgentIdentity("db-executioner", {
      username: "DB Executioner",
      iconEmoji: ":database:",
    });
    clearRegistryForTests();
    store = new CatalogStore(":memory:");
  });

  afterEach(() => {
    delete AGENT_IDENTITIES["db-executioner"];
    clearRegistryForTests();
    store.close();
  });

  it("loads, activates, catalogues, and selects a pinned runbook", async () => {
    const result = await bootstrapRunbookRuntime(store, {
      sources: [{ path: FIXTURE_DIR, origin: "private" }],
      privateCommitSha: "private-commit",
    });

    expect(result).toEqual({
      loaded: 1,
      errors: 0,
      activated: 1,
      deactivated: 0,
    });
    expect(store.getCatalogEntry("runbook", "transfer-ai-roadmaps")).toMatchObject({
      enabled: true,
      repo: "junior-private-agents",
      commitSha: "private-commit",
    });

    const selection = selectRunbook(
      "transfer all AI roadmaps from alice@example.com to bob@example.com",
      { sourceEmail: "alice@example.com", targetEmail: "bob@example.com" },
    );
    expect(selection.selected).toBe(true);
    if (!selection.selected) throw new Error("expected runbook selection");
    expect(selection.runbook.name).toBe("transfer-ai-roadmaps");
  });

  it("deactivates catalogue entries absent from the pinned sources", async () => {
    store.upsertCatalogEntry({
      kind: "runbook",
      name: "removed-runbook",
      repo: "junior-private-agents",
      path: "agents-org/runbooks/removed-runbook.runbook.md",
      commitSha: "old-commit",
      contentDigest: "old-digest",
      schemaVersion: 1,
      enabled: true,
      loadedAt: 1,
      validationStatus: "valid",
      validationErrors: null,
    });

    const result = await bootstrapRunbookRuntime(store, { sources: [] });

    expect(result.deactivated).toBe(1);
    expect(store.getCatalogEntry("runbook", "removed-runbook")?.enabled).toBe(false);
  });
});
