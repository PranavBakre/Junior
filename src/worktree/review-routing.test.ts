import { describe, expect, it } from "bun:test";
import type { RepoConfig } from "../config.ts";
import { inferReviewRepo } from "./review-routing.ts";

const repos: RepoConfig[] = [
  { name: "gx-backend", path: "/repos/backend", defaultBase: "origin/main" },
  { name: "gx-client-expo", path: "/repos/expo", defaultBase: "origin/main" },
];

describe("inferReviewRepo", () => {
  it("routes an explicit PR URL to its configured repository", () => {
    expect(
      inferReviewRepo(
        repos,
        "review https://github.com/GrowthX-Club/gx-client-expo/pull/42",
        ["GrowthX-Club/gx-backend"],
      )?.name,
    ).toBe("gx-client-expo");
  });

  it("uses a single pipeline repo ref when the prompt has no PR URL", () => {
    expect(
      inferReviewRepo(repos, "run aggregate checks", ["GrowthX-Club/gx-backend"])
        ?.name,
    ).toBe("gx-backend");
  });

  it("does not guess when a pipeline spans multiple repositories", () => {
    expect(
      inferReviewRepo(repos, "review the aggregate", [
        "GrowthX-Club/gx-backend",
        "GrowthX-Club/gx-client-expo",
      ]),
    ).toBeUndefined();
  });
});

