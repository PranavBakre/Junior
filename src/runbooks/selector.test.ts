import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import path from "node:path";
import {
  AGENT_IDENTITIES,
  registerAgentIdentity,
} from "../support/agents.ts";
import {
  clearRegistryForTests,
  loadRunbookRegistryFromDir,
} from "./registry.ts";
import { selectRunbook } from "./selector.ts";

const FIXTURE_DIR = path.join(import.meta.dir, "__fixtures__");

describe("runbook selector", () => {
  beforeEach(async () => {
    registerAgentIdentity("db-executioner", {
      username: "DB Executioner",
      iconEmoji: ":database:",
    });
    clearRegistryForTests();
    await loadRunbookRegistryFromDir(FIXTURE_DIR, "private");
  });

  afterEach(() => {
    delete AGENT_IDENTITIES["db-executioner"];
    clearRegistryForTests();
  });

  it("selects with bound inputs when email context is provided", () => {
    const result = selectRunbook(
      "move all AI roadmaps from one account to another",
      {
        sourceEmail: "alice@example.com",
        targetEmail: "bob@example.com",
      },
    );
    expect(result.selected).toBe(true);
    if (!result.selected) return;
    expect(result.runbook.name).toBe("transfer-ai-roadmaps");
    expect(result.boundInputs.bound.sourceEmail).toBe("alice@example.com");
    expect(result.boundInputs.bound.targetEmail).toBe("bob@example.com");
    expect(result.boundInputs.missing).toEqual([]);
  });

  it("selects but reports missing targetEmail when not provided", () => {
    const result = selectRunbook(
      "move all AI roadmaps from one account to another",
      { sourceEmail: "alice@example.com" },
    );
    expect(result.selected).toBe(true);
    if (!result.selected) return;
    expect(result.boundInputs.bound.sourceEmail).toBe("alice@example.com");
    expect(result.boundInputs.missing).toContain("targetEmail");
  });

  it("does not select for 'move one Notion roadmap'", () => {
    const result = selectRunbook("move one Notion roadmap", {});
    expect(result.selected).toBe(false);
    if (result.selected) return;
    expect(["below-threshold", "excluded"]).toContain(result.reason);
  });

  it("does not select for 'transfer every document owned by A'", () => {
    const result = selectRunbook("transfer every document owned by A", {});
    expect(result.selected).toBe(false);
  });

  it("does not select for a completely unrelated request", () => {
    const result = selectRunbook(
      "completely unrelated request about weather patterns",
      {},
    );
    expect(result.selected).toBe(false);
    if (result.selected) return;
    expect(["below-threshold", "no-match"]).toContain(result.reason);
  });

  it("non-match result includes procedureFallback with query and warning", () => {
    const result = selectRunbook(
      "completely unrelated request about weather patterns",
      {},
    );
    expect(result.selected).toBe(false);
    if (result.selected) return;
    expect(result.procedureFallback).toBeDefined();
    expect(result.procedureFallback.query).toBeTruthy();
    expect(result.procedureFallback.query).toBe(
      result.procedureFallback.query.toLowerCase(),
    );
    expect(result.procedureFallback.warning).toContain("procedure memory");
  });

  it("selected result includes evidence with correct digest, risk, and redacted inputs", () => {
    const result = selectRunbook(
      "move all AI roadmaps from one account to another",
      {
        sourceEmail: "alice@example.com",
        targetEmail: "bob@example.com",
      },
    );
    expect(result.selected).toBe(true);
    if (!result.selected) return;

    expect(result.evidence.runbookName).toBe("transfer-ai-roadmaps");
    expect(result.evidence.contentDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.evidence.risk).toBe("production-write");
    expect(result.evidence.status).toBe("selected");
    // Emails should be redacted in evidence
    expect(result.evidence.boundInputs.sourceEmail).toBe("a***@example.com");
    expect(result.evidence.boundInputs.targetEmail).toBe("b***@example.com");
    expect(result.evidence.intentFingerprint).toBeTruthy();
    expect(result.evidence.runId).toBeTruthy();
  });

  it("selected result confidence is > 0.6", () => {
    const result = selectRunbook(
      "move all AI roadmaps from one account to another",
      {
        sourceEmail: "alice@example.com",
        targetEmail: "bob@example.com",
      },
    );
    expect(result.selected).toBe(true);
    if (!result.selected) return;
    expect(result.confidence).toBeGreaterThan(0.6);
  });
});
