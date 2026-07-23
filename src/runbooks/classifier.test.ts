import { describe, expect, it } from "bun:test";
import { classifyReusablePattern } from "./classifier.ts";

describe("runbook classifier", () => {
  describe("classifyReusablePattern", () => {
    it("single occurrence returns memory-claim", () => {
      const result = classifyReusablePattern(
        "deploy the staging server",
        "build",
        "workspace-write",
        [],
        1,
      );
      expect(result.classification).toBe("memory-claim");
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.reason.length).toBeGreaterThan(0);
    });

    it("repeated procedure within owner boundary returns runbook", () => {
      // "build" has repo-read and repo-write; mongo.read requires repo-read only
      const result = classifyReusablePattern(
        "run database migration check",
        "build",
        "production-write",
        ["mongo.read"],
        3,
      );
      expect(result.classification).toBe("runbook");
    });

    it("intent with schedule keyword returns workflow", () => {
      const result = classifyReusablePattern(
        "run cleanup every day at midnight",
        "build",
        "workspace-write",
        [],
        3,
      );
      expect(result.classification).toBe("workflow");
    });

    it("beyond owner capability returns agent-extension", () => {
      // "review" lacks repo-write; migration.execute requires it
      const result = classifyReusablePattern(
        "execute database migration",
        "review",
        "production-write",
        ["migration.execute"],
        3,
      );
      expect(result.classification).toBe("agent-extension");
      expect(result.reason).toContain("review");
    });

    it("unknown owner with capabilities returns new-agent", () => {
      const result = classifyReusablePattern(
        "query the analytics database",
        "unknown-agent-xyz",
        "read-only",
        ["mongo.read"],
        3,
      );
      expect(result.classification).toBe("new-agent");
      expect(result.reason).toContain("unknown-agent-xyz");
    });

    it("repeated procedure with no special signals defaults to runbook", () => {
      // Known owner (build), no capabilities to check, no workflow keywords
      const result = classifyReusablePattern(
        "run the standard deployment checklist",
        "build",
        "workspace-write",
        [],
        5,
      );
      expect(result.classification).toBe("runbook");
    });

    it("every result has confidence and reason", () => {
      const cases = [
        classifyReusablePattern("x", "build", null, [], 1),
        classifyReusablePattern("run schedule job", "build", null, [], 2),
        classifyReusablePattern("migrate", "review", null, ["migration.execute"], 3),
        classifyReusablePattern("query", "unknown-agent-xyz", null, ["mongo.read"], 3),
        classifyReusablePattern("deploy", "build", null, [], 4),
      ];

      for (const result of cases) {
        expect(result.confidence).toBeGreaterThan(0);
        expect(result.confidence).toBeLessThanOrEqual(1);
        expect(result.reason.length).toBeGreaterThan(0);
      }
    });

    describe("workflow keywords", () => {
      const keywords = ["cron", "daily", "on event", "trigger"];

      for (const keyword of keywords) {
        it(`"${keyword}" produces workflow`, () => {
          const result = classifyReusablePattern(
            `run the ${keyword} based cleanup`,
            "build",
            "workspace-write",
            [],
            2,
          );
          expect(result.classification).toBe("workflow");
        });
      }
    });

    it("unknown owner with no capabilities returns runbook not new-agent", () => {
      // No manifest, but capabilities is empty — falls through to default
      const result = classifyReusablePattern(
        "perform routine check",
        "unknown-agent-xyz",
        "read-only",
        [],
        3,
      );
      expect(result.classification).toBe("runbook");
    });
  });
});
