import { describe, expect, it } from "bun:test";
import {
  buildDispatchAllowBlock,
  dispatchableAgentsFor,
  workerMayDispatch,
} from "./agents.ts";

describe("dispatchableAgentsFor", () => {
  it("lets lead dispatch every persistent agent except itself and echo", () => {
    const allowed = dispatchableAgentsFor("lead");
    expect(allowed).toContain("thinker");
    expect(allowed).toContain("review");
    expect(allowed).toContain("reproducer");
    expect(allowed).not.toContain("lead");
    expect(allowed).not.toContain("echo");
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

  it("emits a deny-all block for unknown agents (safe default)", () => {
    const block = buildDispatchAllowBlock("unknown-agent");
    expect(block).toContain("may NOT emit");
  });
});
