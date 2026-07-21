import { describe, expect, it } from "bun:test";
import {
  assertTransition,
  bugTransitions,
  canTransition,
  isBugPhase,
  isProductPhase,
  isTerminalPhase,
  productTransitions,
} from "./transitions.ts";
import type { BugPhase, ProductPhase } from "./types.ts";

describe("product transitions", () => {
  const table = productTransitions();

  it("accepts every declared legal edge", () => {
    for (const [from, tos] of Object.entries(table) as Array<
      [ProductPhase, readonly ProductPhase[]]
    >) {
      for (const to of tos) {
        expect(canTransition("product", from, to)).toBe(true);
      }
      // identity is always legal
      expect(canTransition("product", from, from)).toBe(true);
    }
  });

  it("rejects illegal product edges", () => {
    const illegal: Array<[ProductPhase, ProductPhase]> = [
      ["discovery", "shipped"],
      ["discovery", "reviewing"],
      ["building", "discovery"],
      ["shipped", "building"],
      ["abandoned", "discovery"],
      ["ready-for-human-merge", "building"],
      ["approved", "building"],
    ];
    for (const [from, to] of illegal) {
      expect(canTransition("product", from, to)).toBe(false);
    }
  });

  it("marks shipped and abandoned as terminal", () => {
    expect(isTerminalPhase("product", "shipped")).toBe(true);
    expect(isTerminalPhase("product", "abandoned")).toBe(true);
    expect(isTerminalPhase("product", "building")).toBe(false);
    expect(isTerminalPhase("product", "needs-human")).toBe(false);
  });

  it("reopens an approved candidate when dev verification finds a bug", () => {
    expect(canTransition("product", "approved", "fixing")).toBe(true);
    expect(
      canTransition("product", "ready-for-human-merge", "fixing"),
    ).toBe(true);
    expect(canTransition("product", "shipped", "fixing")).toBe(false);
  });

  it("assertTransition throws on illegal edges", () => {
    expect(() => assertTransition("product", "shipped", "building")).toThrow(
      /Illegal product phase transition/,
    );
    expect(() => assertTransition("product", "building", "pr-open")).not.toThrow();
  });
});

describe("bug transitions", () => {
  const table = bugTransitions();

  it("accepts every declared legal edge", () => {
    for (const [from, tos] of Object.entries(table) as Array<
      [BugPhase, readonly BugPhase[]]
    >) {
      for (const to of tos) {
        expect(canTransition("bug", from, to)).toBe(true);
      }
      expect(canTransition("bug", from, from)).toBe(true);
    }
  });

  it("rejects illegal bug edges", () => {
    const illegal: Array<[BugPhase, BugPhase]> = [
      ["intake", "merged"],
      ["intake", "dev-merge"],
      ["fixing", "intake"],
      ["cleanup", "fixing"],
      ["expected-behavior", "fixing"],
      ["not-reproduced", "evidence"],
      ["abandoned", "intake"],
      ["merged", "fixing"],
    ];
    for (const [from, to] of illegal) {
      expect(canTransition("bug", from, to)).toBe(false);
    }
  });

  it("marks terminal bug phases", () => {
    expect(isTerminalPhase("bug", "cleanup")).toBe(true);
    expect(isTerminalPhase("bug", "expected-behavior")).toBe(true);
    expect(isTerminalPhase("bug", "not-reproduced")).toBe(true);
    expect(isTerminalPhase("bug", "abandoned")).toBe(true);
    expect(isTerminalPhase("bug", "fixing")).toBe(false);
  });

  it("assertTransition throws on illegal edges", () => {
    expect(() => assertTransition("bug", "cleanup", "fixing")).toThrow(
      /Illegal bug phase transition/,
    );
  });
});

describe("phase guards", () => {
  it("recognizes known phases only", () => {
    expect(isProductPhase("building")).toBe(true);
    expect(isProductPhase("not-a-phase")).toBe(false);
    expect(isBugPhase("intake")).toBe(true);
    expect(isBugPhase("shipped")).toBe(false);
  });

  it("rejects cross-kind transitions by phase membership", () => {
    expect(canTransition("product", "intake", "evidence")).toBe(false);
    expect(canTransition("bug", "discovery", "building")).toBe(false);
  });
});
