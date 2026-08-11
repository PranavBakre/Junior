import { describe, expect, it } from "bun:test";
import type { RepoConfig } from "../config.ts";
import {
  inferReviewRepo,
  inferReviewRepos,
  resolveReviewRepos,
  reviewRepoRefs,
} from "./review-routing.ts";

const repos: RepoConfig[] = [
  {
    name: "gx-backend",
    path: "/repos/backend",
    defaultBase: "origin/main",
    githubRepo: "GrowthX-Club/gx-backend",
  },
  {
    name: "gx-client-expo",
    path: "/repos/expo",
    defaultBase: "origin/main",
    githubRepo: "GrowthX-Club/gx-client-expo",
  },
  {
    name: "gx-community",
    path: "/repos/community",
    defaultBase: "origin/main",
    githubRepo: "GrowthX-Club/gx-community",
  },
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

  it("does not fall back to pipeline refs when a PR URL is unresolved", () => {
    expect(
      inferReviewRepo(
        repos,
        "review https://github.com/attacker/gx-backend/pull/9",
        ["GrowthX-Club/gx-backend"],
      ),
    ).toBeUndefined();
  });
});

describe("inferReviewRepos", () => {
  it("collects every configured repository referenced by a multi-PR review", () => {
    expect(
      inferReviewRepos(
        repos,
        [
          "review these PRs:",
          "https://github.com/GrowthX-Club/gx-client-expo/pull/5614",
          "https://github.com/GrowthX-Club/gx-backend/pull/3597",
          "https://github.com/GrowthX-Club/gx-community/pull/742",
        ].join("\n"),
      ).map((repo) => repo.name),
    ).toEqual(["gx-client-expo", "gx-backend", "gx-community"]);
  });

  it("preserves every URL coordinate and reports unresolved repositories", () => {
    const prompt = [
      "https://github.com/GrowthX-Club/gx-backend/pull/1",
      "https://github.com/GrowthX-Club/not-configured/pull/2",
    ].join(" ");
    expect(reviewRepoRefs(prompt)).toEqual([
      "GrowthX-Club/gx-backend",
      "GrowthX-Club/not-configured",
    ]);
    expect(resolveReviewRepos(repos, prompt)).toMatchObject({
      repos: [repos[0]],
      unresolvedRefs: ["GrowthX-Club/not-configured"],
      ambiguousRefs: [],
    });
    expect(inferReviewRepos(repos, prompt)).toEqual([]);
  });

  it("matches the exact owner and reports duplicate configured identities as ambiguous", () => {
    expect(
      resolveReviewRepos(
        repos,
        "review https://github.com/attacker/gx-backend/pull/9",
      ).unresolvedRefs,
    ).toEqual(["attacker/gx-backend"]);

    const duplicate = {
      name: "gx-backend-mirror",
      path: "/repos/backend-mirror",
      defaultBase: "origin/main",
      githubRepo: "GrowthX-Club/gx-backend",
    };
    expect(
      resolveReviewRepos(
        [...repos, duplicate],
        "review https://github.com/GrowthX-Club/gx-backend/pull/9",
      ).ambiguousRefs,
    ).toEqual(["GrowthX-Club/gx-backend"]);
  });
});
