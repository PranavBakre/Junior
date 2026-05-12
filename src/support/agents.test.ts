import { describe, expect, it } from "bun:test";
import {
  AGENT_IDENTITIES,
  agentForUsername,
  buildDispatchAllowBlock,
  dispatchableAgentsFor,
  isOrchestratorAgent,
  workerMayDispatch,
} from "./agents.ts";

describe("dispatchableAgentsFor", () => {
  it("lets lead dispatch every worker except itself, default, and echo", () => {
    const allowed = dispatchableAgentsFor("lead");
    expect(allowed).toContain("thinker");
    expect(allowed).toContain("review");
    expect(allowed).toContain("reproducer");
    expect(allowed).toContain("onboard-member");
    expect(allowed).not.toContain("lead");
    expect(allowed).not.toContain("default");
    expect(allowed).not.toContain("echo");
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
    expect(dispatchableAgentsFor("onboard-member")).toEqual([]);
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
    expect(isOrchestratorAgent("onboard-member")).toBe(false);
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

  it("lists every dispatchable agent for default Junior too", () => {
    const block = buildDispatchAllowBlock("default");
    expect(block).toContain("`thinker`");
    expect(block).toContain("`review`");
    expect(block).toContain("`reproducer`");
    expect(block).toContain("`onboard-member`");
    expect(block).not.toContain("may NOT emit");
  });

  it("emits a deny-all block for unknown agents (safe default)", () => {
    const block = buildDispatchAllowBlock("unknown-agent");
    expect(block).toContain("may NOT emit");
  });
});
