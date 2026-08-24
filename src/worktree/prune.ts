import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename } from "node:path";
import type { RepoConfig } from "../config.ts";
import { cleanGitHubEnvironment, GitHubAuthResolver } from "../github/auth.ts";
import { isDotenvPath } from "./safety.ts";

export interface WorktreePruneScope {
  repoNames?: readonly string[];
  branches?: ReadonlyMap<string, readonly string[]>;
}

export interface WorktreePruneReport {
  reposInspected: string[];
  removed: Array<{ repo: string; path: string; branch: string | null }>;
  skipped: Array<{ repo: string; path: string; reason: string }>;
  failures: Array<{ repo: string; message: string }>;
}

interface ListedWorktree {
  path: string;
  branch: string | null;
  locked: boolean;
}

/**
 * Deterministic, conservative half of worktree pruning. It only removes a
 * present, unlocked secondary worktree when its HEAD is merged into the
 * configured base and it has neither meaningful changes nor ignored dotenv
 * files. Generated PNGs and next-env.d.ts are harmless residual state and do
 * not prevent pruning. Anything needing preservation or interpretation is
 * reported as skipped.
 */
export async function pruneWorktrees(
  repos: readonly RepoConfig[],
  scope: WorktreePruneScope = {},
): Promise<WorktreePruneReport> {
  const report: WorktreePruneReport = {
    reposInspected: [], removed: [], skipped: [], failures: [],
  };
  const allowedRepos = scope.repoNames ? new Set(scope.repoNames) : null;
  const githubAuth = new GitHubAuthResolver(repos);

  for (const repo of repos) {
    if (allowedRepos && !allowedRepos.has(repo.name)) continue;
    if (!existsSync(repo.path)) {
      report.failures.push({ repo: repo.name, message: "primary checkout is unavailable" });
      continue;
    }
    report.reposInspected.push(repo.name);
    try {
      const githubEnv = await githubAuth.environmentForRepo(repo);
      const base = await resolveBase(repo, githubEnv);
      const primary = await canonicalPath(repo.path);
      const worktrees = parseWorktrees(await git(repo.path, ["worktree", "list", "--porcelain"], githubEnv));
      const allowedBranches = scope.branches?.get(repo.name);
      for (const worktree of worktrees) {
        if ((await canonicalPath(worktree.path)) === primary) continue;
        if (isDevServerWorktree(worktree)) continue;
        if (allowedBranches && (!worktree.branch || !allowedBranches.includes(worktree.branch))) continue;
        if (!existsSync(worktree.path)) {
          report.skipped.push({ repo: repo.name, path: worktree.path, reason: "path is missing" });
          continue;
        }
        if (worktree.locked) {
          report.skipped.push({ repo: repo.name, path: worktree.path, reason: "worktree is locked" });
          continue;
        }
        if (await hasActiveProcess(worktree.path)) {
          report.skipped.push({ repo: repo.name, path: worktree.path, reason: "worktree has an active process" });
          continue;
        }
        if (!await isMerged(worktree.path, base, githubEnv)) {
          report.skipped.push({ repo: repo.name, path: worktree.path, reason: `HEAD is not merged into ${base}` });
          continue;
        }
        const dirty = await git(worktree.path, ["status", "--porcelain", "--untracked-files=all"], githubEnv);
        const dirtyPaths = statusPaths(dirty);
        const meaningfulPaths = dirtyPaths.filter((path) => !isPrunableResidualPath(path));
        if (meaningfulPaths.length) {
          report.skipped.push({ repo: repo.name, path: worktree.path, reason: `meaningful changes: ${meaningfulPaths.join(", ")}` });
          continue;
        }
        const ignored = await git(worktree.path, ["ls-files", "--others", "--ignored", "--exclude-standard"], githubEnv);
        if (ignored.split(/\r?\n/).some(isDotenvPath)) {
          report.skipped.push({ repo: repo.name, path: worktree.path, reason: "ignored dotenv files require preservation review" });
          continue;
        }
        // The force is scoped to this exact worktree. It is required when the
        // only residual files are the generated paths allowed above; all
        // meaningful and preservation-sensitive state has already been gated.
        await git(repo.path, ["worktree", "remove", "--force", worktree.path], githubEnv);
        if (existsSync(worktree.path)) {
          throw new Error(`git worktree remove succeeded but path remains: ${worktree.path}`);
        }
        report.removed.push({ repo: repo.name, path: worktree.path, branch: worktree.branch });
      }
    } catch (error) {
      report.failures.push({ repo: repo.name, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return report;
}

export function formatWorktreePruneReport(report: WorktreePruneReport): string {
  const lines = [`Repos inspected: ${report.reposInspected.join(", ") || "none"}`];
  lines.push(`Removed: ${report.removed.length}`);
  for (const item of report.removed) lines.push(`- ${item.repo}: ${item.path}`);
  lines.push(`Skipped: ${report.skipped.length}`);
  for (const item of report.skipped) lines.push(`- ${item.repo}: ${item.path} — ${item.reason}`);
  if (report.failures.length) {
    lines.push(`Failures: ${report.failures.length}`);
    for (const failure of report.failures) lines.push(`- ${failure.repo}: ${failure.message}`);
  }
  return lines.join("\n");
}

async function resolveBase(repo: RepoConfig, githubEnv?: Record<string, string>): Promise<string> {
  const configured = repo.defaultBase.replace(/^origin\//, "");
  await git(repo.path, ["fetch", "origin", configured, "--prune"], githubEnv);
  for (const candidate of [`origin/${configured}`, configured]) {
    if (await gitExitCode(repo.path, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], githubEnv) === 0) {
      return candidate;
    }
  }
  throw new Error(`cannot resolve default base ${repo.defaultBase}`);
}

function parseWorktrees(output: string): ListedWorktree[] {
  const records = output.trim().split(/\n\n+/).filter(Boolean);
  return records.flatMap((record) => {
    const fields = new Map(record.split(/\r?\n/).map((line) => {
      const [key, ...rest] = line.split(" ");
      return [key, rest.join(" ")];
    }));
    const path = fields.get("worktree");
    if (!path) return [];
    const branchRef = fields.get("branch") ?? null;
    return [{
      path,
      branch: branchRef?.replace(/^refs\/heads\//, "") ?? null,
      locked: fields.has("locked"),
    }];
  });
}

async function isMerged(worktreePath: string, base: string, githubEnv?: Record<string, string>): Promise<boolean> {
  return await gitExitCode(worktreePath, ["merge-base", "--is-ancestor", "HEAD", base], githubEnv) === 0;
}

function isDevServerWorktree(worktree: ListedWorktree): boolean {
  return worktree.branch === "slack-dev-server" ||
    worktree.branch?.startsWith("dev-server-slot/") === true ||
    basename(worktree.path) === "slack-dev-server";
}

function isPrunableResidualPath(path: string): boolean {
  return path.toLowerCase().endsWith(".png") || basename(path) === "next-env.d.ts";
}

function statusPaths(output: string): string[] {
  return output.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).trim()).filter(Boolean);
}

async function canonicalPath(path: string): Promise<string> {
  try { return await realpath(path); } catch { return path; }
}

async function git(cwd: string, args: string[], githubEnv?: Record<string, string>): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: githubEnv ? { ...cleanGitHubEnvironment(), ...githubEnv } : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`git ${args[0]} failed: ${stderr.trim() || stdout.trim()}`);
  return stdout;
}

async function gitExitCode(cwd: string, args: string[], githubEnv?: Record<string, string>): Promise<number> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: githubEnv ? { ...cleanGitHubEnvironment(), ...githubEnv } : undefined,
    stdout: "ignore",
    stderr: "ignore",
  });
  return await proc.exited;
}

async function hasActiveProcess(path: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["lsof", "-a", "-d", "cwd", "-Fn"], {
      stdout: "pipe", stderr: "ignore",
    });
    const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    // An unavailable lsof makes cleanup less trustworthy; skip rather than
    // guessing that a worktree is unused.
    if (code !== 0 && !stdout.trim()) return true;
    return stdout.split(/\r?\n/).some((line) => line.startsWith("n") && (
      line.slice(1) === path || line.slice(1).startsWith(`${path}/`)
    ));
  } catch {
    return true;
  }
}
