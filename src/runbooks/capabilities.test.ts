import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  CAPABILITY_BUNDLES,
  isCapabilitySubset,
  isValidCapabilityBundle,
  listCapabilityBundles,
} from "./capabilities.ts";
import {
  AGENT_IDENTITIES,
  registerAgentIdentity,
} from "../support/agents.ts";

describe("capability bundles", () => {
  describe("isValidCapabilityBundle", () => {
    it("all defined bundles are valid", () => {
      for (const name of Object.keys(CAPABILITY_BUNDLES)) {
        expect(isValidCapabilityBundle(name)).toBe(true);
      }
    });

    it("unknown bundle is invalid", () => {
      expect(isValidCapabilityBundle("nonexistent.bundle")).toBe(false);
      expect(isValidCapabilityBundle("")).toBe(false);
      expect(isValidCapabilityBundle("mongo")).toBe(false);
    });
  });

  describe("listCapabilityBundles", () => {
    it("returns all bundle names", () => {
      const bundles = listCapabilityBundles();
      expect(bundles).toContain("mongo.read");
      expect(bundles).toContain("migration.execute");
      expect(bundles).toContain("slack.read");
      expect(bundles).toContain("github.read");
      expect(bundles.length).toBe(Object.keys(CAPABILITY_BUNDLES).length);
    });
  });

  describe("isCapabilitySubset", () => {
    describe("build agent (has repo-read + repo-write)", () => {
      it("mongo.read OK (requires repo-read)", () => {
        const result = isCapabilitySubset(["mongo.read"], "build");
        expect(result.ok).toBe(true);
        expect(result.violations).toEqual([]);
      });

      it("migration.execute OK (requires repo-read + repo-write)", () => {
        const result = isCapabilitySubset(["migration.execute"], "build");
        expect(result.ok).toBe(true);
        expect(result.violations).toEqual([]);
      });

      it("multiple valid bundles OK", () => {
        const result = isCapabilitySubset(
          ["mongo.read", "migration.execute", "migration.inspect"],
          "build",
        );
        expect(result.ok).toBe(true);
        expect(result.violations).toEqual([]);
      });
    });

    describe("review agent (has repo-read but NOT repo-write)", () => {
      it("mongo.read OK (requires only repo-read)", () => {
        const result = isCapabilitySubset(["mongo.read"], "review");
        expect(result.ok).toBe(true);
        expect(result.violations).toEqual([]);
      });

      it("migration.execute FAILS (requires repo-write which review lacks)", () => {
        const result = isCapabilitySubset(["migration.execute"], "review");
        expect(result.ok).toBe(false);
        expect(result.violations.length).toBeGreaterThan(0);
        expect(result.violations[0]).toContain("repo-write");
        expect(result.violations[0]).toContain("review");
      });

      it("github.read OK (requires repo-read + github-review-read)", () => {
        const result = isCapabilitySubset(["github.read"], "review");
        expect(result.ok).toBe(true);
        expect(result.violations).toEqual([]);
      });
    });

    describe("overlay-only agent (no catalog entry)", () => {
      beforeEach(() => {
        registerAgentIdentity("overlay-only-test", {
          username: "Overlay Test",
          iconEmoji: ":test_tube:",
        });
      });

      afterEach(() => {
        delete AGENT_IDENTITIES["overlay-only-test"];
      });

      it("validates bundle names only, no capability check", () => {
        const result = isCapabilitySubset(
          ["mongo.read", "migration.execute"],
          "overlay-only-test",
        );
        expect(result.ok).toBe(true);
        expect(result.violations).toEqual([]);
      });

      it("unknown bundle still reported for overlay-only agent", () => {
        const result = isCapabilitySubset(
          ["mongo.read", "bogus.cap"],
          "overlay-only-test",
        );
        expect(result.ok).toBe(false);
        expect(result.violations.length).toBe(1);
        expect(result.violations[0]).toContain('unknown capability bundle "bogus.cap"');
      });
    });

    describe("unknown bundle", () => {
      it("reports a violation for an unknown bundle", () => {
        const result = isCapabilitySubset(
          ["mongo.read", "nonexistent.bundle"],
          "build",
        );
        expect(result.ok).toBe(false);
        expect(
          result.violations.some((v) =>
            v.includes('unknown capability bundle "nonexistent.bundle"'),
          ),
        ).toBe(true);
      });
    });
  });
});
