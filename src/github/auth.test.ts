import { describe, expect, it } from "bun:test";
import type { RepoConfig } from "../config.ts";
import { GitHubAuthResolver } from "./auth.ts";

const repo: RepoConfig = {
  name: "gx-client-next",
  path: "/tmp/gx-client-next",
  defaultBase: "origin/main",
  githubRepo: "GrowthX-Club/gx-client-next",
  githubUser: "pranav-growthx",
};

describe("GitHubAuthResolver", () => {
  it("resolves and caches the configured account without changing global gh state", async () => {
    const calls: Array<{ args: string[]; env: Record<string, string> }> = [];
    const previous = {
      GH_TOKEN: process.env.GH_TOKEN,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      GH_ENTERPRISE_TOKEN: process.env.GH_ENTERPRISE_TOKEN,
      GH_CONFIG_DIR: process.env.GH_CONFIG_DIR,
    };
    process.env.GH_TOKEN = "wrong-global-token";
    process.env.GITHUB_TOKEN = "wrong-account-token";
    process.env.GH_ENTERPRISE_TOKEN = "wrong-enterprise-token";
    process.env.GH_CONFIG_DIR = "/tmp/wrong-gh-config";
    try {
      const resolver = new GitHubAuthResolver([repo], async (args, env) => {
        calls.push({ args, env });
        return args[0] === "auth"
          ? { status: 0, stdout: "selected-token\n", stderr: "" }
          : { status: 0, stdout: "pranav-growthx\n", stderr: "" };
      });

      const first = await resolver.environmentForRepoName("gx-client-next");
      const second = await resolver.environmentForRepoRef(
        "growthx-club/gx-client-next",
      );

      if (!first) throw new Error("configured repository did not resolve an identity");
      expect(first).toMatchObject({
        GH_TOKEN: "selected-token",
        GH_PROMPT_DISABLED: "1",
      });
      expect(first.GH_CONFIG_DIR).toContain("junior-gh-isolated");
      expect(second).toEqual(first);
      expect(calls).toHaveLength(2);
      expect(calls[0]?.args).toEqual([
        "auth",
        "token",
        "--user",
        "pranav-growthx",
      ]);
      expect(calls[0]?.env.GH_TOKEN).toBeUndefined();
      expect(calls[0]?.env.GITHUB_TOKEN).toBeUndefined();
      expect(calls[0]?.env.GH_ENTERPRISE_TOKEN).toBeUndefined();
      expect(calls[0]?.env.GH_CONFIG_DIR).toBeUndefined();
      expect(calls[1]?.env.GH_TOKEN).toBe("selected-token");
      expect(calls[1]?.env.GH_CONFIG_DIR).toBeUndefined();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("fails closed when gh authenticates as a different user", async () => {
    const resolver = new GitHubAuthResolver([repo], async (args) =>
      args[0] === "auth"
        ? { status: 0, stdout: "selected-token", stderr: "" }
        : { status: 0, stdout: "PranavBakre", stderr: "" },
    );

    await expect(resolver.environmentForRepo(repo)).rejects.toThrow(
      "GitHub identity mismatch for repo gx-client-next",
    );
  });

  it("does not produce GitHub credentials for repos without a selection", async () => {
    const unselected = { ...repo, githubUser: undefined };
    const resolver = new GitHubAuthResolver([
      unselected,
    ]);

    expect(await resolver.environmentForRepo(unselected)).toBeUndefined();
  });

  it("fails closed when a GitHub repository is missing its configured identity", async () => {
    const resolver = new GitHubAuthResolver([{
      ...repo,
      githubUser: undefined,
    }]);

    await expect(
      resolver.environmentForRepoRef("GrowthX-Club/gx-client-next"),
    ).rejects.toThrow("must configure githubUser");
    await expect(
      resolver.environmentForRepoRef("GrowthX-Club/other-repo"),
    ).rejects.toThrow("No GitHub identity is configured");
  });

  it("rejects a selected account that lacks an exact repository mapping", async () => {
    const resolver = new GitHubAuthResolver([{
      ...repo,
      githubRepo: undefined,
    }]);

    await expect(resolver.environmentForRepo({
      ...repo,
      githubRepo: undefined,
    })).rejects.toThrow("must configure githubRepo with githubUser");
  });
});
