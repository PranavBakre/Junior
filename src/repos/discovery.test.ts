import { afterEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoConfig } from "../config.ts";
import {
  discoverLocalRepos,
  githubRepoFromRemote,
  mergeConfiguredAndDiscoveredRepos,
  parseRepoDiscoveryRoots,
} from "./discovery.ts";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("local repository discovery", () => {
  it("normalizes GitHub HTTPS and SSH remotes to owner/repo", () => {
    expect(githubRepoFromRemote("https://github.com/GrowthX-Club/junior.git"))
      .toBe("GrowthX-Club/junior");
    expect(githubRepoFromRemote("git@github.com:PranavBakre/Junior.git"))
      .toBe("PranavBakre/Junior");
    expect(githubRepoFromRemote("/tmp/local-repo")).toBeNull();
  });

  it("discovers primary checkouts with origin and derives setup metadata", () => {
    const root = makeTempRoot();
    const repoPath = makeRepo(root, "product-repo", { setupScript: true });

    expect(discoverLocalRepos([root])).toEqual([
      {
        name: "product-repo",
        path: repoPath,
        defaultBase: "origin/main",
        worktreeSetupCommand: "scripts/setup-worktree.sh",
      },
    ]);
  });

  it("skips linked-worktree-shaped directories and repos without origin", () => {
    const root = makeTempRoot();
    makeRepo(root, "no-origin", { origin: false });
    const linked = join(root, "linked-worktree");
    mkdirSync(linked);
    writeFileSync(join(linked, ".git"), "gitdir: /tmp/example\n");

    expect(discoverLocalRepos([root])).toEqual([]);
  });

  it("keeps explicit repo metadata ahead of discovered values", () => {
    const root = makeTempRoot();
    const path = makeRepo(root, "product-repo");
    const configured: RepoConfig = {
      name: "product-repo",
      path,
      defaultBase: "origin/dev",
      devCommand: "pnpm dev",
    };

    expect(mergeConfiguredAndDiscoveredRepos([configured], [root])).toEqual([
      configured,
    ]);
  });

  it("rejects duplicate discovered names across roots", () => {
    const first = makeTempRoot();
    const second = makeTempRoot();
    makeRepo(first, "same-name");
    makeRepo(second, "same-name");

    expect(() => mergeConfiguredAndDiscoveredRepos([], [first, second])).toThrow(
      /duplicate repository names.*same-name/,
    );
  });

  it("lets an explicit entry resolve a discovered name collision", () => {
    const first = makeTempRoot();
    const second = makeTempRoot();
    const selectedPath = makeRepo(first, "same-name");
    makeRepo(second, "same-name");
    const configured: RepoConfig = {
      name: "same-name",
      path: selectedPath,
      defaultBase: "origin/main",
    };

    expect(
      mergeConfiguredAndDiscoveredRepos([configured], [first, second]),
    ).toEqual([configured]);
  });

  it("validates the discovery-root JSON contract", () => {
    expect(parseRepoDiscoveryRoots(undefined)).toEqual([]);
    expect(parseRepoDiscoveryRoots('["./one","./one"]')).toHaveLength(1);
    expect(() => parseRepoDiscoveryRoots("./one")).toThrow(
      /JSON array of paths/,
    );
    expect(() => parseRepoDiscoveryRoots('[""]')).toThrow(
      /non-empty paths/,
    );
  });
});

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "junior-repo-discovery-"));
  tempRoots.push(root);
  return root;
}

function makeRepo(
  root: string,
  name: string,
  options: { origin?: boolean; setupScript?: boolean } = {},
): string {
  const path = join(root, name);
  mkdirSync(path);
  runGit(path, ["init", "-q", "-b", "main"]);
  runGit(path, ["config", "user.email", "test@example.com"]);
  runGit(path, ["config", "user.name", "Test"]);
  writeFileSync(join(path, "README.md"), "test\n");
  runGit(path, ["add", "README.md"]);
  runGit(path, ["commit", "-q", "-m", "init"]);

  if (options.origin !== false) {
    runGit(path, ["remote", "add", "origin", path]);
    runGit(path, ["fetch", "-q", "origin"]);
  }
  if (options.setupScript) {
    const scripts = join(path, "scripts");
    mkdirSync(scripts);
    const setup = join(scripts, "setup-worktree.sh");
    writeFileSync(setup, "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(setup, 0o755);
  }
  return realpathSync(path);
}

function runGit(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
}
