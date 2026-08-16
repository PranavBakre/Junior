import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneWorktrees } from "./prune.ts";

let repoPath: string;

async function git(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (await proc.exited !== 0) throw new Error(await new Response(proc.stderr).text());
}

beforeAll(async () => {
  repoPath = mkdtempSync(join(tmpdir(), "junior-prune-test-"));
  await git(repoPath, ["init", "-q", "-b", "main"]);
  await git(repoPath, ["config", "user.email", "test@example.com"]);
  await git(repoPath, ["config", "user.name", "test"]);
  writeFileSync(join(repoPath, ".gitignore"), ".env\n");
  writeFileSync(join(repoPath, "README.md"), "test\n");
  await git(repoPath, ["add", "."]);
  await git(repoPath, ["commit", "-qm", "init"]);
  await git(repoPath, ["remote", "add", "origin", repoPath]);
  await git(repoPath, ["fetch", "-q", "origin"]);
});

afterAll(() => rmSync(repoPath, { recursive: true, force: true }));

describe("pruneWorktrees", () => {
  it("removes only a clean merged secondary worktree", async () => {
    const cleanPath = `${repoPath}.clean`;
    await git(repoPath, ["worktree", "add", "-b", "clean", cleanPath, "main"]);
    const canonicalCleanPath = await realpath(cleanPath);

    const report = await pruneWorktrees([{ name: "repo", path: repoPath, defaultBase: "origin/main" }]);

    expect(report.removed).toEqual([{ repo: "repo", path: canonicalCleanPath, branch: "clean" }]);
    expect(existsSync(cleanPath)).toBe(false);
  });

  it("skips ignored dotenv files instead of removing them", async () => {
    const dotenvPath = `${repoPath}.dotenv`;
    await git(repoPath, ["worktree", "add", "-b", "dotenv", dotenvPath, "main"]);
    const canonicalDotenvPath = await realpath(dotenvPath);
    writeFileSync(join(dotenvPath, ".env"), "SECRET=value\n");

    const report = await pruneWorktrees([{ name: "repo", path: repoPath, defaultBase: "origin/main" }]);

    expect(report.removed).toEqual([]);
    expect(report.skipped).toContainEqual({
      repo: "repo", path: canonicalDotenvPath, reason: "ignored dotenv files require preservation review",
    });
    await git(repoPath, ["worktree", "remove", "--force", dotenvPath]);
  });
});
