import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import path from "node:path";
import { CatalogStore } from "../../runbooks/catalog-store.ts";
import {
  clearRegistryForTests,
  loadRunbookRegistryFromDir,
} from "../../runbooks/registry.ts";
import {
  AGENT_IDENTITIES,
  registerAgentIdentity,
} from "../../support/agents.ts";
import { handleRunbookDetail, handleRunbooks } from "./runbooks.ts";

const fixtureDir = path.join(import.meta.dir, "../../runbooks/__fixtures__");

describe("handleRunbooks", () => {
  beforeEach(() => {
    registerAgentIdentity("db-executioner", {
      username: "DB Executioner",
      iconEmoji: ":database:",
    });
    clearRegistryForTests();
  });

  afterEach(() => {
    delete AGENT_IDENTITIES["db-executioner"];
    clearRegistryForTests();
  });

  it("returns an empty list when the registry is empty", async () => {
    const response = await handleRunbooks(new URLSearchParams());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ runbooks: [], errors: [] });
  });

  it("lists and searches loaded runbooks", async () => {
    const loaded = await loadRunbookRegistryFromDir(fixtureDir, "private");
    expect(loaded.errors).toBe(0);

    const catalog = new CatalogStore(":memory:");
    catalog.upsertCatalogEntry({
      kind: "runbook",
      name: "transfer-ai-roadmaps",
      repo: "agents-org",
      path: "runbooks/transfer-ai-roadmaps.runbook.md",
      commitSha: "abc123",
      contentDigest: "digest",
      schemaVersion: 1,
      enabled: true,
      loadedAt: 1,
      validationStatus: "valid",
      validationErrors: null,
    });

    const listed = await handleRunbooks(new URLSearchParams(), catalog);
    expect(listed.status).toBe(200);
    const listBody = await listed.json() as {
      runbooks: Array<{ name: string; filePath: string | null }>;
    };
    expect(listBody.runbooks.some((item) => item.name === "transfer-ai-roadmaps")).toBe(true);
    expect(
      listBody.runbooks.find((item) => item.name === "transfer-ai-roadmaps")?.filePath,
    ).toContain("transfer-ai-roadmaps.runbook.md");

    const searched = await handleRunbooks(
      new URLSearchParams("query=roadmap"),
      catalog,
    );
    const searchBody = await searched.json() as { runbooks: Array<{ name: string }> };
    expect(searchBody.runbooks.map((item) => item.name)).toContain("transfer-ai-roadmaps");
  });

  it("returns 404 for an unknown runbook", async () => {
    const response = await handleRunbookDetail("missing-runbook");
    expect(response.status).toBe(404);
  });

  it("returns the prompt body on get", async () => {
    await loadRunbookRegistryFromDir(fixtureDir, "private");
    const response = await handleRunbookDetail("transfer-ai-roadmaps");
    expect(response.status).toBe(200);
    const body = await response.json() as {
      runbook: { name: string; prompt: string };
    };
    expect(body.runbook.name).toBe("transfer-ai-roadmaps");
    expect(body.runbook.prompt.length).toBeGreaterThan(0);
  });
});
