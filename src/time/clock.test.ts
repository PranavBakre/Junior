import { describe, expect, it } from "bun:test";
import { fakeClock, systemClock } from "./clock.ts";

describe("systemClock", () => {
  it("returns a finite epoch ms near Date.now()", () => {
    const before = Date.now();
    const now = systemClock.now();
    const after = Date.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });
});

describe("fakeClock", () => {
  it("starts at the provided value", () => {
    const clock = fakeClock(1_000);
    expect(clock.now()).toBe(1_000);
  });

  it("advances and sets deterministically", () => {
    const clock = fakeClock(0);
    clock.advance(50);
    expect(clock.now()).toBe(50);
    clock.set(999);
    expect(clock.now()).toBe(999);
    clock.advance(1);
    expect(clock.now()).toBe(1_000);
  });
});
