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
      expect(patterns).toContain("git blame *");
      expect(patterns).toContain("gh pr list *");
      expect(patterns.some((pattern) => pattern.startsWith("gh api"))).toBe(false);
      expect(patterns).not.toContain("gh pr checkout *");
      expect(patterns).not.toContain(`${manager} run test:* *`);
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
