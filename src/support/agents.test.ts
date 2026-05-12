import { afterEach, describe, expect, it } from "bun:test";
import path from "node:path";
import fs from "node:fs/promises";
import {
  AGENT_IDENTITIES,
  agentForUsername,
  buildDispatchAllowBlock,
  dispatchableAgentsFor,
  isOrchestratorAgent,
  loadOverlayIdentities,
  registerAgentIdentity,
  workerMayDispatch,
} from "./agents.ts";

describe("dispatchableAgentsFor", () => {
  const cleanupKeys: string[] = [];
  afterEach(() => {
    for (const key of cleanupKeys) {
      delete AGENT_IDENTITIES[key];
    }
    cleanupKeys.length = 0;
  });

  it("lets lead dispatch every worker except itself, default, and echo", () => {
    const allowed = dispatchableAgentsFor("lead");
    expect(allowed).toContain("thinker");
    expect(allowed).toContain("review");
    expect(allowed).toContain("reproducer");
    expect(allowed).not.toContain("lead");
    expect(allowed).not.toContain("default");
    expect(allowed).not.toContain("echo");
  });

  it("includes overlay-registered workers in lead's allow-list once registered", () => {
    cleanupKeys.push("overlay-worker-test");
    registerAgentIdentity("overlay-worker-test", {
      username: "OverlayTest",
      iconEmoji: ":test_tube:",
    });
    expect(dispatchableAgentsFor("lead")).toContain("overlay-worker-test");
  });

  it("gives default Junior the same full dispatch power as lead", () => {
    const leadAllowed = dispatchableAgentsFor("lead").sort();
    const defaultAllowed = dispatchableAgentsFor("default").sort();
    const juniorAllowed = dispatchableAgentsFor("junior").sort();
    expect(defaultAllowed).toEqual(leadAllowed);
    expect(juniorAllowed).toEqual(leadAllowed);
  });

  it("returns thinker's allow-list", () => {
    const allowed = dispatchableAgentsFor("thinker").sort();
    expect(allowed).toEqual(["reproducer", "review"]);
  });

  it("returns empty for workers with no allow-list", () => {
    expect(dispatchableAgentsFor("review")).toEqual([]);
    expect(dispatchableAgentsFor("reproducer")).toEqual([]);
  });

  it("returns empty for unknown agents", () => {
    expect(dispatchableAgentsFor("unknown-agent")).toEqual([]);
  });
});

describe("identity / username collision (the footgun this guards)", () => {
  it("lead and default Junior have different slack usernames", () => {
    expect(AGENT_IDENTITIES.lead.username).not.toBe(
      AGENT_IDENTITIES.default.username,
    );
  });

  it("agentForUsername resolves 'Junior' to default, not lead", () => {
    expect(agentForUsername("Junior")).toBe("default");
  });

  it("agentForUsername resolves 'Junior (Lead)' to lead", () => {
    expect(agentForUsername("Junior (Lead)")).toBe("lead");
  });

  it("isOrchestratorAgent recognises both orchestrators and rejects workers", () => {
    expect(isOrchestratorAgent("lead")).toBe(true);
    expect(isOrchestratorAgent("default")).toBe(true);
    expect(isOrchestratorAgent("junior")).toBe(true);
    expect(isOrchestratorAgent("thinker")).toBe(false);
    expect(isOrchestratorAgent("review")).toBe(false);
    expect(isOrchestratorAgent(null)).toBe(false);
  });
});

describe("workerMayDispatch", () => {
  it("permits thinker → review", () => {
    expect(workerMayDispatch("thinker", "review")).toBe(true);
  });

  it("permits thinker → reproducer", () => {
    expect(workerMayDispatch("thinker", "reproducer")).toBe(true);
  });

  it("blocks reproducer → thinker", () => {
    expect(workerMayDispatch("reproducer", "thinker")).toBe(false);
  });

  it("blocks unknown source agents", () => {
    expect(workerMayDispatch("unknown", "review")).toBe(false);
  });
});

describe("buildDispatchAllowBlock", () => {
  it("emits an allow-list for thinker", () => {
    const block = buildDispatchAllowBlock("thinker");
    expect(block).toContain("<dispatch-allow>");
    expect(block).toContain("</dispatch-allow>");
    expect(block).toContain("`reproducer`");
    expect(block).toContain("`review`");
    expect(block).toContain("the code wins");
  });

  it("emits a deny-all block for review", () => {
    const block = buildDispatchAllowBlock("review");
    expect(block).toContain("<dispatch-allow>");
    expect(block).toContain("may NOT emit");
    expect(block).toContain("re-routed to lead");
    expect(block).not.toContain("`reproducer`");
  });

  it("emits a deny-all block for reproducer", () => {
    const block = buildDispatchAllowBlock("reproducer");
    expect(block).toContain("may NOT emit");
  });

  it("lists every dispatchable agent for lead", () => {
    const block = buildDispatchAllowBlock("lead");
    expect(block).toContain("`thinker`");
    expect(block).toContain("`review`");
    expect(block).toContain("`reproducer`");
    expect(block).not.toContain("may NOT emit");
  });

  it("lists every dispatchable core agent for default Junior too", () => {
    const block = buildDispatchAllowBlock("default");
    expect(block).toContain("`thinker`");
    expect(block).toContain("`review`");
    expect(block).toContain("`reproducer`");
    expect(block).not.toContain("may NOT emit");
  });

  it("emits a deny-all block for unknown agents (safe default)", () => {
    const block = buildDispatchAllowBlock("unknown-agent");
    expect(block).toContain("may NOT emit");
  });
});

describe("registerAgentIdentity", () => {
  const cleanupKeys: string[] = [];
  afterEach(() => {
    for (const key of cleanupKeys) {
      delete AGENT_IDENTITIES[key];
    }
    cleanupKeys.length = 0;
  });

  it("registers a new overlay agent identity", () => {
    cleanupKeys.push("test-worker");
    const ok = registerAgentIdentity("test-worker", {
      username: "Tester",
      iconEmoji: ":test_tube:",
    });
    expect(ok).toBe(true);
    expect(AGENT_IDENTITIES["test-worker"]).toEqual({
      username: "Tester",
      iconEmoji: ":test_tube:",
    });
  });

  it("refuses to overwrite a core agent identity", () => {
    const before = AGENT_IDENTITIES.lead;
    const ok = registerAgentIdentity("lead", {
      username: "HijackedLead",
      iconEmoji: ":skull:",
    });
    expect(ok).toBe(false);
    expect(AGENT_IDENTITIES.lead).toEqual(before);
  });
});

describe("loadOverlayIdentities", () => {
  const tmpDir = path.join(import.meta.dir, "__overlay_test");
  const cleanupKeys: string[] = [];

  afterEach(async () => {
    for (const key of cleanupKeys) {
      delete AGENT_IDENTITIES[key];
    }
    cleanupKeys.length = 0;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("registers identities from .md frontmatter in the overlay dir", async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    await Bun.write(
      path.join(tmpDir, "overlay-worker.md"),
      `---
name: overlay-worker
description: Test overlay worker
username: OverlayPerson
iconEmoji: ":construction:"
---

body
`,
    );

    cleanupKeys.push("overlay-worker");
    await loadOverlayIdentities(tmpDir);

    expect(AGENT_IDENTITIES["overlay-worker"]).toEqual({
      username: "OverlayPerson",
      iconEmoji: ":construction:",
    });
  });

  it("skips .md files that declare only one of username/iconEmoji", async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    await Bun.write(
      path.join(tmpDir, "half-identity.md"),
      `---
name: half-identity
description: Missing iconEmoji
username: OnlyUsername
---

body
`,
    );

    await loadOverlayIdentities(tmpDir);
    expect(AGENT_IDENTITIES["half-identity"]).toBeUndefined();
  });

  it("skips .md files that have identity fields but no name", async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    await Bun.write(
      path.join(tmpDir, "no-name-but-identity.md"),
      `---
description: Forgot to put a name on this one
username: Anonymous
iconEmoji: ":ghost:"
---

body
`,
    );

    // Should not throw and should not register anything (no name to key on).
    await loadOverlayIdentities(tmpDir);
    expect(AGENT_IDENTITIES["Anonymous"]).toBeUndefined();
  });

  it("does not throw when the overlay directory is missing", async () => {
    const missing = path.join(import.meta.dir, "__definitely_not_here");
    await expect(loadOverlayIdentities(missing)).resolves.toBeUndefined();
  });
});
