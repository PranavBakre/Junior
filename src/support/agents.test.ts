import { afterEach, describe, expect, it } from "bun:test";
import path from "node:path";
import fs from "node:fs/promises";
import {
  AGENT_IDENTITIES,
  agentForUsername,
  buildDispatchAllowBlock,
  canDispatch,
  dispatchableAgentsFor,
  isOrchestratorAgent,
  loadOverlayIdentities,
  registerAgentIdentity,
  resetShadowResolveForTests,
  shadowResolveAgentCatalog,
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
    expect(allowed).toContain("review");
    expect(allowed).toContain("reproducer");
    expect(allowed).not.toContain("thinker"); // retired in the 3-way merge
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

  it("keeps thinker's legacy allow-list (resumed pre-merge sessions)", () => {
    expect(dispatchableAgentsFor("thinker").sort()).toEqual(["reproducer", "review"]);
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
  it("allows only thinker's legacy chain after the merge", () => {
    // Live workers never dispatch each other — the orchestrator emits
    // !reproducer/!review itself. The thinker entry is legacy-only, for
    // pre-merge sessions resumed under the "thinker" name; it mirrors its old
    // rights so the dispatch-allow block doesn't contradict the bug-pipeline
    // preamble those sessions receive.
    expect(workerMayDispatch("thinker", "review")).toBe(true);
    expect(workerMayDispatch("thinker", "reproducer")).toBe(true);
    expect(workerMayDispatch("reproducer", "review")).toBe(false);
    expect(workerMayDispatch("review", "reproducer")).toBe(false);
  });

  it("blocks unknown source agents", () => {
    expect(workerMayDispatch("unknown", "review")).toBe(false);
  });
});

describe("canDispatch (catalog-preferring)", () => {
  it("uses the trusted handoff graph for catalog sources", () => {
    expect(canDispatch("pm", "architect")).toBe(true);
    expect(canDispatch("pm", "build")).toBe(true);
    expect(canDispatch("architect", "frontend")).toBe(true);
    expect(canDispatch("build", "frontend")).toBe(true);
    expect(canDispatch("frontend", "build")).toBe(true);
    expect(canDispatch("review", "build")).toBe(true);
    expect(canDispatch("reproducer", "review")).toBe(true);
    expect(canDispatch("review", "reproducer")).toBe(false);
    expect(canDispatch("pm", "review")).toBe(false);
  });

  it("resolves symbolic orchestrator by context", () => {
    expect(canDispatch("pm", "orchestrator", "support")).toBe(true);
    expect(canDispatch("pm", "lead", "support")).toBe(true);
    expect(canDispatch("pm", "default", "default")).toBe(true);
  });

  it("always allows human escalation for catalog roles", () => {
    expect(canDispatch("review", "human")).toBe(true);
    expect(canDispatch("build", "human")).toBe(true);
  });

  it("falls back to legacy WORKER_DISPATCH_ALLOW for thinker", () => {
    // thinker is not in the catalog — legacy path only.
    expect(canDispatch("thinker", "review")).toBe(true);
    expect(canDispatch("thinker", "reproducer")).toBe(true);
    expect(canDispatch("thinker", "build")).toBe(false);
  });

  it("lets orchestrators dispatch overlay workers via legacy identity registry", () => {
    const key = "overlay-can-dispatch-test";
    registerAgentIdentity(key, {
      username: "OverlayCanDispatch",
      iconEmoji: ":test_tube:",
    });
    try {
      expect(canDispatch("lead", key)).toBe(true);
      expect(canDispatch("default", key)).toBe(true);
    } finally {
      delete AGENT_IDENTITIES[key];
    }
  });

  it("shadow-resolve is idempotent and does not throw", () => {
    resetShadowResolveForTests();
    expect(() => shadowResolveAgentCatalog()).not.toThrow();
    expect(() => shadowResolveAgentCatalog()).not.toThrow();
  });
});

describe("buildDispatchAllowBlock", () => {
  it("emits thinker's legacy allow-list (consistent with the pipeline preamble)", () => {
    const block = buildDispatchAllowBlock("thinker");
    expect(block).toContain("<dispatch-allow>");
    expect(block).toContain("</dispatch-allow>");
    expect(block).toContain("`reproducer`");
    expect(block).toContain("`review`");
    expect(block).not.toContain("may NOT emit");
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
    expect(block).toContain("`review`");
    expect(block).toContain("`reproducer`");
    expect(block).not.toContain("`thinker`");
    expect(block).not.toContain("may NOT emit");
  });

  it("lists every dispatchable core agent for default Junior too", () => {
    const block = buildDispatchAllowBlock("default");
    expect(block).toContain("`review`");
    expect(block).toContain("`reproducer`");
    expect(block).not.toContain("`thinker`");
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

  it("registers identities that use imageUrl instead of iconEmoji", async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    await Bun.write(
      path.join(tmpDir, "image-worker.md"),
      `---
name: image-worker
description: Test image worker
username: ImagePerson
imageUrl: "https://example.com/icon.png"
---

body
`,
    );

    cleanupKeys.push("image-worker");
    await loadOverlayIdentities(tmpDir);

    expect(AGENT_IDENTITIES["image-worker"]).toEqual({
      username: "ImagePerson",
      imageUrl: "https://example.com/icon.png",
    });
  });

  it("skips .md files that declare only one identity field", async () => {
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

  it("does not throw when the configured agents-org overlay directory is missing", async () => {
    const missing = path.join(import.meta.dir, "agents-org-missing");
    await expect(loadOverlayIdentities(missing)).resolves.toBeUndefined();
  });
});
