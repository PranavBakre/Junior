import { describe, expect, it } from "bun:test";
import type { RepoConfig } from "../config.ts";
import {
  identityAmbiguousRepos,
  resolveIdentityRepo,
  resolveIdentityRepoName,
} from "./identity-routing.ts";

const repos: RepoConfig[] = [
  {
    name: "gx-backend",
    path: "/repos/backend",
    defaultBase: "origin/main",
    githubRepo: "GrowthX-Club/gx-backend",
    githubUser: "gxt-admin",
  },
  {
    name: "gx-client-next",
    path: "/repos/client-next",
    defaultBase: "origin/main",
    githubRepo: "GrowthX-Club/gx-client-next",
    githubUser: "gxt-admin",
  },
  {
    name: "junior",
    path: "/repos/junior",
    defaultBase: "origin/main",
    githubRepo: "PranavBakre/Junior",
    githubUser: "PranavBakre",
  },
];

const resolve = (prompt: string, targetRepoName?: string) =>
  resolveIdentityRepoName({ repos, prompt, targetRepoName });

describe("resolveIdentityRepoName", () => {
  it("binds a PR-URL-only directive with no durable repo", () => {
    expect(
      resolve(
        "in gx-client-next merge https://github.com/GrowthX-Club/gx-client-next/pull/5944 via gxt-admin",
      ),
    ).toBe("gx-client-next");
  });

  it("ignores an incidental unconfigured link beside the target", () => {
    expect(
      resolve(
        "merge https://github.com/GrowthX-Club/gx-client-next/pull/5944 (upstream fix is https://github.com/Other-Org/lib/pull/7)",
      ),
    ).toBe("gx-client-next");
  });

  it("binds a bare repository URL", () => {
    expect(resolve("merge https://github.com/GrowthX-Club/gx-backend")).toBe(
      "gx-backend",
    );
  });

  it("binds a bare repository URL that ends a sentence", () => {
    expect(resolve("merge https://github.com/GrowthX-Club/gx-backend.")).toBe(
      "gx-backend",
    );
  });

  it("binds a gh --repo argument", () => {
    expect(resolve("gh pr merge 1 --repo GrowthX-Club/gx-backend")).toBe(
      "gx-backend",
    );
  });

  it("binds the equals and shorthand forms gh also accepts", () => {
    expect(resolve("gh pr merge 1 --repo=GrowthX-Club/gx-backend")).toBe(
      "gx-backend",
    );
    expect(resolve("gh pr merge 1 -RGrowthX-Club/gx-backend")).toBe("gx-backend");
    expect(resolve("gh pr merge 1 -R GrowthX-Club/gx-backend")).toBe("gx-backend");
  });

  it("prefers the target repo over a repo named in the prompt", () => {
    expect(
      resolve(
        "merge https://github.com/GrowthX-Club/gx-client-next/pull/5944",
        "gx-backend",
      ),
    ).toBe("gx-backend");
  });

  it("lets a repo named in the prompt override the durable binding", () => {
    // The binding is a fallback, not a preference: a directive that names a
    // configured repo is more specific than the thread's last binding.
    expect(
      resolveIdentityRepoName({
        repos,
        durableIdentityRepo: "gx-backend",
        prompt: "merge https://github.com/GrowthX-Club/gx-client-next/pull/5944",
      }),
    ).toBe("gx-client-next");
  });

  it("keeps the durable binding when the prompt names nothing configured", () => {
    expect(
      resolveIdentityRepoName({
        repos,
        durableIdentityRepo: "gx-backend",
        prompt: "go ahead",
      }),
    ).toBe("gx-backend");
  });

  it("does not guess an identity when no repo is named", () => {
    expect(resolve("merge the open PR please")).toBeUndefined();
  });

  it("ignores a bare repo name in prose", () => {
    expect(resolve("in gx-client-next merge the benefits toggle fix")).toBeUndefined();
  });

  it("refuses an unresolvable PR URL rather than guessing", () => {
    expect(
      resolve("review https://github.com/Other-Org/unconfigured/pull/12"),
    ).toBeUndefined();
  });

  it("refuses when two configured repos are named", () => {
    expect(
      resolve(
        "review https://github.com/GrowthX-Club/gx-backend/pull/1 and https://github.com/GrowthX-Club/gx-client-next/pull/2",
      ),
    ).toBeUndefined();
  });
});

describe("durable identity", () => {
  it("keeps the bound identity across a follow-up with no coordinate", () => {
    expect(
      resolveIdentityRepoName({
        repos,
        durableIdentityRepo: "gx-client-next",
        prompt: "yes go ahead",
      }),
    ).toBe("gx-client-next");
  });

  it("lets an explicit coordinate in the new directive override it", () => {
    expect(
      resolveIdentityRepoName({
        repos,
        durableIdentityRepo: "gx-client-next",
        prompt: "actually merge https://github.com/GrowthX-Club/gx-backend/pull/3",
      }),
    ).toBe("gx-backend");
  });

  it("keeps the durable binding when the directive names two repos", () => {
    expect(
      resolveIdentityRepoName({
        repos,
        durableIdentityRepo: "gx-client-next",
        prompt:
          "compare https://github.com/GrowthX-Club/gx-backend/pull/1 with https://github.com/GrowthX-Club/gx-client-next/pull/2",
      }),
    ).toBe("gx-client-next");
  });
});

describe("resolveIdentityRepo", () => {
  it("returns the configured identity, not just the name", () => {
    expect(
      resolveIdentityRepo({
        repos,
        prompt: "merge https://github.com/PranavBakre/Junior/pull/228",
      })?.githubUser,
    ).toBe("PranavBakre");
  });
});

describe("identityAmbiguousRepos", () => {
  it("names both repos when one directive names two configured ones", () => {
    expect(
      identityAmbiguousRepos({
        repos,
        prompt:
          "merge https://github.com/GrowthX-Club/gx-backend/pull/1 (upstream fix is https://github.com/GrowthX-Club/gx-client-next/pull/2)",
      }),
    ).toEqual(["gx-backend", "gx-client-next"]);
  });

  it("stays empty when a durable binding resolves the ambiguity", () => {
    // The thread already committed to a repository, so the turn keeps its
    // credentials and there is nothing to explain.
    expect(
      identityAmbiguousRepos({
        repos,
        durableIdentityRepo: "gx-backend",
        prompt:
          "merge https://github.com/GrowthX-Club/gx-backend/pull/1 (upstream fix is https://github.com/GrowthX-Club/gx-client-next/pull/2)",
      }),
    ).toEqual([]);
  });

  it("stays empty when an identity resolved", () => {
    expect(
      identityAmbiguousRepos({
        repos,
        prompt: "merge https://github.com/GrowthX-Club/gx-backend/pull/1",
      }),
    ).toEqual([]);
  });

  it("ignores coordinates that match nothing configured", () => {
    expect(
      identityAmbiguousRepos({
        repos,
        prompt:
          "merge https://github.com/GrowthX-Club/gx-backend/pull/1 (upstream fix is https://github.com/Other-Org/lib/pull/7)",
      }),
    ).toEqual([]);
  });
});
