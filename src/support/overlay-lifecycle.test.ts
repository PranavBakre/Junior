import { afterEach, describe, expect, it } from "bun:test";
import path from "node:path";
import fs from "node:fs/promises";
import { loadAgentDefinition } from "../agents/loader.ts";
import {
  AGENT_IDENTITIES,
  canDispatch,
  dispatchableAgentsFor,
  isPersistentAgent,
  loadOverlayIdentities,
} from "./agents.ts";

/**
 * Overlay lifecycle fixtures and tests — Iteration 0 of the
 * common-task-agent-authoring plan.
 *
 * Proves the end-to-end private overlay contract: a newly merged private agent
 * can be loaded, validated, reloaded, found by search, and dispatched without a
 * process restart.
 */

const FIXTURE_DIR = path.join(import.meta.dir, "__overlay_lifecycle_test");

// ─── fixture content ────────────────────────────────────────────────────────

const VALID_PRIVATE_AGENT = `---
name: test-private-worker
description: A valid private overlay agent for lifecycle testing
username: TestWorker
iconEmoji: ":hammer:"
tools: mcp__slack-bot__memory_recall
permissions.intent: normal
---

You are a test worker. Execute the assigned task.
`;

const VALID_PRIVATE_AGENT_IMAGE_URL = `---
name: test-image-worker
description: Private agent using imageUrl for identity
username: ImageWorker
imageUrl: "https://example.com/avatar.png"
tools: mcp__slack-bot__memory_recall
permissions.intent: normal
---

You are an image-url test worker.
`;

const INVALID_IDENTITY_NO_ICON = `---
name: invalid-no-icon
description: Agent with username but no iconEmoji or imageUrl
username: BrokenAgent
tools: mcp__slack-bot__memory_recall
---

Should not register — incomplete identity.
`;

const INVALID_IDENTITY_NO_USERNAME = `---
name: invalid-no-username
description: Agent with iconEmoji but no username
iconEmoji: ":broken_heart:"
tools: mcp__slack-bot__memory_recall
---

Should not register — incomplete identity.
`;

const INVALID_IDENTITY_NO_NAME = `---
description: Agent with full identity fields but no name
username: NoName
iconEmoji: ":question:"
---

Should not register — no name to key on.
`;

const DUPLICATE_CORE_NAME = `---
name: default
description: Attempt to hijack the default orchestrator
username: HijackedJunior
iconEmoji: ":skull:"
tools: mcp__slack-bot__memory_recall
---

This agent tries to override the core default agent identity.
`;

const DUPLICATE_CORE_NAME_LEAD = `---
name: lead
description: Attempt to hijack the lead orchestrator
username: HijackedLead
iconEmoji: ":skull:"
---

This agent tries to override the core lead agent identity.
`;

const SECOND_PRIVATE_AGENT = `---
name: test-second-worker
description: A second private agent for reload testing
username: SecondWorker
iconEmoji: ":wrench:"
---

You are a second test worker, added after the initial load.
`;

// ─── helpers ────────────────────────────────────────────────────────────────

async function writeFixture(filename: string, content: string): Promise<void> {
  await Bun.write(path.join(FIXTURE_DIR, filename), content);
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe("overlay lifecycle: valid private agent", () => {
  const cleanupKeys: string[] = [];

  afterEach(async () => {
    for (const key of cleanupKeys) delete AGENT_IDENTITIES[key];
    cleanupKeys.length = 0;
    await fs.rm(FIXTURE_DIR, { recursive: true, force: true });
  });

  it("loads a valid private agent definition from .md", async () => {
    await fs.mkdir(FIXTURE_DIR, { recursive: true });
    await writeFixture("test-private-worker.md", VALID_PRIVATE_AGENT);

    const def = await loadAgentDefinition(
      path.join(FIXTURE_DIR, "test-private-worker.md"),
    );
    expect(def).not.toBeNull();
    expect(def!.name).toBe("test-private-worker");
    expect(def!.description).toBe(
      "A valid private overlay agent for lifecycle testing",
    );
    expect(def!.username).toBe("TestWorker");
    expect(def!.iconEmoji).toBe(":hammer:");
    expect(def!.prompt).toContain("Execute the assigned task");
  });

  it("registers identity and becomes dispatchable after loadOverlayIdentities", async () => {
    await fs.mkdir(FIXTURE_DIR, { recursive: true });
    await writeFixture("test-private-worker.md", VALID_PRIVATE_AGENT);
    cleanupKeys.push("test-private-worker");

    await loadOverlayIdentities(FIXTURE_DIR);

    expect(AGENT_IDENTITIES["test-private-worker"]).toEqual({
      username: "TestWorker",
      iconEmoji: ":hammer:",
    });
    expect(isPersistentAgent("test-private-worker")).toBe(true);
    expect(dispatchableAgentsFor("default")).toContain("test-private-worker");
    expect(canDispatch("default", "test-private-worker")).toBe(true);
    expect(canDispatch("lead", "test-private-worker")).toBe(true);
  });

  it("supports imageUrl identity as an alternative to iconEmoji", async () => {
    await fs.mkdir(FIXTURE_DIR, { recursive: true });
    await writeFixture("test-image-worker.md", VALID_PRIVATE_AGENT_IMAGE_URL);
    cleanupKeys.push("test-image-worker");

    await loadOverlayIdentities(FIXTURE_DIR);

    expect(AGENT_IDENTITIES["test-image-worker"]).toEqual({
      username: "ImageWorker",
      imageUrl: "https://example.com/avatar.png",
    });
    expect(isPersistentAgent("test-image-worker")).toBe(true);
  });
});

describe("overlay lifecycle: invalid identity", () => {
  afterEach(async () => {
    await fs.rm(FIXTURE_DIR, { recursive: true, force: true });
  });

  it("skips agent with username but no iconEmoji/imageUrl", async () => {
    await fs.mkdir(FIXTURE_DIR, { recursive: true });
    await writeFixture("invalid-no-icon.md", INVALID_IDENTITY_NO_ICON);

    await loadOverlayIdentities(FIXTURE_DIR);
    expect(AGENT_IDENTITIES["invalid-no-icon"]).toBeUndefined();
    expect(isPersistentAgent("invalid-no-icon")).toBe(false);
  });

  it("skips agent with iconEmoji but no username", async () => {
    await fs.mkdir(FIXTURE_DIR, { recursive: true });
    await writeFixture("invalid-no-username.md", INVALID_IDENTITY_NO_USERNAME);

    await loadOverlayIdentities(FIXTURE_DIR);
    expect(AGENT_IDENTITIES["invalid-no-username"]).toBeUndefined();
  });

  it("skips agent with full identity fields but no name", async () => {
    await fs.mkdir(FIXTURE_DIR, { recursive: true });
    await writeFixture("no-name.md", INVALID_IDENTITY_NO_NAME);

    await loadOverlayIdentities(FIXTURE_DIR);
    // No name means the identity can't be keyed — nothing registers
    expect(AGENT_IDENTITIES["NoName"]).toBeUndefined();
  });

  it("validates definition even when identity is invalid", async () => {
    await fs.mkdir(FIXTURE_DIR, { recursive: true });
    await writeFixture("invalid-no-icon.md", INVALID_IDENTITY_NO_ICON);

    const def = await loadAgentDefinition(
      path.join(FIXTURE_DIR, "invalid-no-icon.md"),
    );
    expect(def).not.toBeNull();
    expect(def!.name).toBe("invalid-no-icon");
    expect(def!.username).toBe("BrokenAgent");
    expect(def!.iconEmoji).toBeNull();
  });
});

describe("overlay lifecycle: duplicate name", () => {
  afterEach(async () => {
    await fs.rm(FIXTURE_DIR, { recursive: true, force: true });
  });

  it("refuses to overwrite core 'default' agent via overlay load", async () => {
    await fs.mkdir(FIXTURE_DIR, { recursive: true });
    await writeFixture("default.md", DUPLICATE_CORE_NAME);

    const before = { ...AGENT_IDENTITIES.default };
    await loadOverlayIdentities(FIXTURE_DIR);

    expect(AGENT_IDENTITIES.default).toEqual(before);
    expect(AGENT_IDENTITIES.default.username).toBe("Junior");
  });

  it("refuses to overwrite core 'lead' agent via overlay load", async () => {
    await fs.mkdir(FIXTURE_DIR, { recursive: true });
    await writeFixture("lead.md", DUPLICATE_CORE_NAME_LEAD);

    const before = { ...AGENT_IDENTITIES.lead };
    await loadOverlayIdentities(FIXTURE_DIR);

    expect(AGENT_IDENTITIES.lead).toEqual(before);
    expect(AGENT_IDENTITIES.lead.username).toBe("Junior (Lead)");
  });

  it("still loads the definition even if identity registration is refused", async () => {
    await fs.mkdir(FIXTURE_DIR, { recursive: true });
    await writeFixture("default.md", DUPLICATE_CORE_NAME);

    const def = await loadAgentDefinition(
      path.join(FIXTURE_DIR, "default.md"),
    );
    expect(def).not.toBeNull();
    expect(def!.name).toBe("default");
    expect(def!.description).toBe(
      "Attempt to hijack the default orchestrator",
    );
  });
});

describe("overlay lifecycle: registry reload", () => {
  const cleanupKeys: string[] = [];

  afterEach(async () => {
    for (const key of cleanupKeys) delete AGENT_IDENTITIES[key];
    cleanupKeys.length = 0;
    await fs.rm(FIXTURE_DIR, { recursive: true, force: true });
  });

  it("reload picks up a newly added agent without restart", async () => {
    await fs.mkdir(FIXTURE_DIR, { recursive: true });
    await writeFixture("test-private-worker.md", VALID_PRIVATE_AGENT);
    cleanupKeys.push("test-private-worker", "test-second-worker");

    // Initial load — only the first agent
    await loadOverlayIdentities(FIXTURE_DIR);
    expect(isPersistentAgent("test-private-worker")).toBe(true);
    expect(isPersistentAgent("test-second-worker")).toBe(false);

    // Simulate a submodule update that adds a second agent
    await writeFixture("test-second-worker.md", SECOND_PRIVATE_AGENT);

    // Reload — both agents should now be registered
    await loadOverlayIdentities(FIXTURE_DIR);
    expect(isPersistentAgent("test-second-worker")).toBe(true);
    expect(AGENT_IDENTITIES["test-second-worker"]).toEqual({
      username: "SecondWorker",
      iconEmoji: ":wrench:",
    });
  });

  it("reload is idempotent — re-registering same agents does not error", async () => {
    await fs.mkdir(FIXTURE_DIR, { recursive: true });
    await writeFixture("test-private-worker.md", VALID_PRIVATE_AGENT);
    cleanupKeys.push("test-private-worker");

    await loadOverlayIdentities(FIXTURE_DIR);
    const identity = { ...AGENT_IDENTITIES["test-private-worker"] };

    // Second load should not throw and should not change the identity
    await loadOverlayIdentities(FIXTURE_DIR);
    expect(AGENT_IDENTITIES["test-private-worker"]).toEqual(identity);
  });

  it("newly reloaded agent is searchable by definition scanning", async () => {
    await fs.mkdir(FIXTURE_DIR, { recursive: true });
    await writeFixture("test-private-worker.md", VALID_PRIVATE_AGENT);
    cleanupKeys.push("test-private-worker");

    await loadOverlayIdentities(FIXTURE_DIR);

    // Simulate what agent_search does: scan the directory and load definitions
    const entries = await fs.readdir(FIXTURE_DIR);
    const mdFiles = entries.filter((f) => f.endsWith(".md"));
    const results = [];
    for (const file of mdFiles) {
      const def = await loadAgentDefinition(path.join(FIXTURE_DIR, file));
      if (!def) continue;
      results.push({
        name: def.name,
        description: def.description,
        registeredForDispatch: isPersistentAgent(def.name),
      });
    }

    const found = results.find((r) => r.name === "test-private-worker");
    expect(found).toBeDefined();
    expect(found!.registeredForDispatch).toBe(true);
    expect(found!.description).toBe(
      "A valid private overlay agent for lifecycle testing",
    );
  });

  it("newly reloaded agent is dispatchable by all orchestrators", async () => {
    await fs.mkdir(FIXTURE_DIR, { recursive: true });
    await writeFixture("test-private-worker.md", VALID_PRIVATE_AGENT);
    cleanupKeys.push("test-private-worker");

    await loadOverlayIdentities(FIXTURE_DIR);

    // Dispatchable by orchestrators
    expect(canDispatch("default", "test-private-worker")).toBe(true);
    expect(canDispatch("lead", "test-private-worker")).toBe(true);
    expect(canDispatch("junior", "test-private-worker")).toBe(true);

    // Not dispatchable by non-orchestrator workers (no worker→worker entry)
    expect(canDispatch("review", "test-private-worker")).toBe(false);
    expect(canDispatch("reproducer", "test-private-worker")).toBe(false);
  });

  it("full lifecycle: load → register → search → dispatch", async () => {
    await fs.mkdir(FIXTURE_DIR, { recursive: true });
    await writeFixture("test-private-worker.md", VALID_PRIVATE_AGENT);
    cleanupKeys.push("test-private-worker");

    // Step 1: Load definition — validates the .md parses correctly
    const def = await loadAgentDefinition(
      path.join(FIXTURE_DIR, "test-private-worker.md"),
    );
    expect(def).not.toBeNull();
    expect(def!.name).toBe("test-private-worker");

    // Step 2: Register via overlay load — simulates submodule pull + reload
    await loadOverlayIdentities(FIXTURE_DIR);
    expect(isPersistentAgent("test-private-worker")).toBe(true);

    // Step 3: Search — agent is findable by scanning the overlay directory
    const searchDef = await loadAgentDefinition(
      path.join(FIXTURE_DIR, "test-private-worker.md"),
    );
    expect(searchDef!.name).toBe("test-private-worker");
    const identity = AGENT_IDENTITIES["test-private-worker"];
    expect(identity).toBeDefined();
    expect(identity.username).toBe("TestWorker");

    // Step 4: Dispatch — orchestrators can dispatch the new agent
    expect(canDispatch("default", "test-private-worker")).toBe(true);
    expect(dispatchableAgentsFor("default")).toContain("test-private-worker");
  });

  it("mixed load: valid agents register, invalid ones don't, core names protected", async () => {
    await fs.mkdir(FIXTURE_DIR, { recursive: true });
    await writeFixture("test-private-worker.md", VALID_PRIVATE_AGENT);
    await writeFixture("invalid-no-icon.md", INVALID_IDENTITY_NO_ICON);
    await writeFixture("default.md", DUPLICATE_CORE_NAME);
    cleanupKeys.push("test-private-worker");

    const defaultBefore = { ...AGENT_IDENTITIES.default };
    await loadOverlayIdentities(FIXTURE_DIR);

    // Valid agent registered
    expect(isPersistentAgent("test-private-worker")).toBe(true);
    // Invalid identity skipped
    expect(AGENT_IDENTITIES["invalid-no-icon"]).toBeUndefined();
    // Core agent protected
    expect(AGENT_IDENTITIES.default).toEqual(defaultBefore);
  });
});
