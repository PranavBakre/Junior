#!/usr/bin/env bun
import type { RepoConfig } from "../src/config.ts";
import { formatWorktreePruneReport, pruneWorktrees } from "../src/worktree/prune.ts";

const rawRepos = process.env.REPOS;
if (!rawRepos) throw new Error("REPOS must be set to run worktree-prune");
const repos = JSON.parse(rawRepos) as RepoConfig[];
const args = process.argv.slice(2);
let repoName: string | undefined;
let branch: string | undefined;
while (args.length) {
  const flag = args.shift();
  const value = args.shift();
  if (!value) throw new Error(`${flag} requires a value`);
  if (flag === "--repo") repoName = value;
  else if (flag === "--branch") branch = value;
  else throw new Error(`Unknown worktree-prune argument: ${flag}`);
}
if (branch && !repoName) throw new Error("--branch requires --repo");
const report = await pruneWorktrees(repos, repoName ? {
  repoNames: [repoName],
  ...(branch ? { branches: new Map([[repoName, [branch]]]) } : {}),
} : {});
console.log(formatWorktreePruneReport(report));
if (report.failures.length) process.exitCode = 1;
