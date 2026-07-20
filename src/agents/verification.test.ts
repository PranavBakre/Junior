import { describe, expect, it } from "bun:test";
import { worktreeVerificationCommandPatterns } from "./verification.ts";

describe("worktreeVerificationCommandPatterns", () => {
  it.each(["npm", "pnpm", "bun"] as const)(
    "emits verification commands only for detected %s",
    (manager) => {
      const patterns = worktreeVerificationCommandPatterns(manager);
      expect(patterns).toContain(`${manager} test`);
      expect(patterns).toContain(`${manager} run typecheck`);
      expect(patterns).toContain("git diff *");
      for (const other of ["npm", "pnpm", "bun"] as const) {
        if (other !== manager) {
          expect(patterns).not.toContain(`${other} test`);
        }
      }
      expect(patterns.some((pattern) => pattern.includes("install"))).toBe(false);
      expect(patterns.some((pattern) => pattern.includes("publish"))).toBe(false);
    },
  );
});

