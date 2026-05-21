import { describe, expect, it } from "bun:test";
import { msUntilNextDailyRun } from "./scheduler.ts";

describe("msUntilNextDailyRun", () => {
  it("schedules later today when the time has not passed", () => {
    const now = new Date(2026, 4, 21, 10, 0, 0, 0);

    expect(msUntilNextDailyRun(now, "18:00")).toBe(8 * 60 * 60 * 1000);
  });

  it("schedules tomorrow when the time has passed", () => {
    const now = new Date(2026, 4, 21, 19, 30, 0, 0);

    expect(msUntilNextDailyRun(now, "18:00")).toBe(22.5 * 60 * 60 * 1000);
  });
});
