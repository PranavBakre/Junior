import { describe, expect, it } from "bun:test";
import type { RepoConfig } from "../config.ts";
import { resolveIdentityRepoName } from "./identity-routing.ts";

const repos: RepoConfig[] = [
  {
    name: "gx-backend",
    path: "/repos/backend",
    defaultBase: "origin/main",
    githubRepo: "GrowthX-Club/gx-backend",
  },
  {
    name: "gx-client-next",
    path: "/repos/client-next",
    defaultBase: "origin/main",
    githubRepo: "GrowthX-Club/gx-client-next",
  },
];

describe("resolveIdentityRepoName", () => {
  it("binds a PR-URL-only directive with no durable repo", () => {
    expect(
      resolveIdentityRepoName({
        repos,
        prompt:
          "in gx-client-next merge https://github.com/GrowthX-Club/gx-client-next/pull/5944 via gxt-admin",
      }),
    ).toBe("gx-client-next");
  });

  it("prefers the durable binding over the prompt", () => {
    expect(
      resolveIdentityRepoName({
        targetRepoName: "gx-backend",
        repos,
        prompt: "merge https://github.com/GrowthX-Club/gx-client-next/pull/5944",
      }),
    ).toBe("gx-backend");
  });

  it("does not guess an identity when no repo is named", () => {
    expect(
      resolveIdentityRepoName({ repos, prompt: "merge the open PR please" }),
    ).toBeUndefined();
  });

  it("ignores a bare repo name in prose", () => {
    expect(
      resolveIdentityRepoName({
        repos,
        prompt: "in gx-client-next merge the benefits toggle fix",
      }),
    ).toBeUndefined();
  });

  it("refuses an unresolvable PR URL rather than guessing", () => {
    expect(
      resolveIdentityRepoName({
        repos,
        prompt: "review https://github.com/Other-Org/unconfigured/pull/12",
      }),
    ).toBeUndefined();
  });

  it("refuses when two PR URLs disagree", () => {
    expect(
      resolveIdentityRepoName({
        repos,
        prompt:
          "review https://github.com/GrowthX-Club/gx-backend/pull/1 and https://github.com/GrowthX-Club/gx-client-next/pull/2",
      }),
    ).toBeUndefined();
  });
});
