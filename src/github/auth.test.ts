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
    const previousToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "wrong-account-token";
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

      expect(first).toEqual({
        GH_TOKEN: "selected-token",
        GH_PROMPT_DISABLED: "1",
      });
      expect(second).toEqual(first);
      expect(calls).toHaveLength(2);
      expect(calls[0]?.args).toEqual([
        "auth",
        "token",
        "--user",
        "pranav-growthx",
      ]);
      expect(calls[0]?.env.GITHUB_TOKEN).toBeUndefined();
      expect(calls[1]?.env.GH_TOKEN).toBe("selected-token");
    } finally {
      if (previousToken === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = previousToken;
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

  it("leaves repos without a selection on the existing host auth path", async () => {
    const unselected = { ...repo, githubUser: undefined };
    const resolver = new GitHubAuthResolver([
      unselected,
    ]);

    expect(await resolver.environmentForRepo(unselected)).toBeUndefined();
  });
});
