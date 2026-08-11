import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  type Dirent,
  lstatSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { RepoConfig } from "../config.ts";

const DEFAULT_BASE_CANDIDATES = [
  "origin/main",
  "origin/dev",
  "origin/master",
] as const;

export function parseRepoDiscoveryRoots(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("REPO_DISCOVERY_ROOTS must be a JSON array of paths");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((value) => typeof value !== "string" || !value.trim())
  ) {
    throw new Error("REPO_DISCOVERY_ROOTS must be a JSON array of non-empty paths");
  }

  return [
    ...new Set(
      parsed.map((value) => normalizePath(value as string)),
    ),
  ];
}

/**
 * Discover primary Git checkouts one directory below each configured root.
 *
 * Linked worktrees are deliberately excluded (`.git` is a file there), as are
 * repositories without an `origin` remote or a locally-known remote default
 * base. Junior can only promise safe, reproducible worktree creation for
 * checkouts that satisfy those constraints.
 */
export function discoverLocalRepos(roots: string[]): RepoConfig[] {
  const discovered: RepoConfig[] = [];
  const seenPaths = new Set<string>();

  for (const root of roots) {
    let entries: Dirent[];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        entry.name.startsWith(".") ||
        entry.name.endsWith(".junior-worktrees")
      ) {
        continue;
      }

      const path = join(root, entry.name);
      if (!isPrimaryGitCheckout(path)) continue;

      const canonicalPath = safeRealpath(path);
      if (!canonicalPath || seenPaths.has(canonicalPath)) continue;
      if (!git(path, ["remote", "get-url", "origin"])) continue;

      const defaultBase = detectDefaultBase(path);
      if (!defaultBase) continue;

      seenPaths.add(canonicalPath);
      const setupCommand = detectSetupCommand(path);
      discovered.push({
        name: basename(canonicalPath),
        path: canonicalPath,
        defaultBase,
        ...(setupCommand ? { worktreeSetupCommand: setupCommand } : {}),
      });
    }
  }

  discovered.sort((a, b) =>
    a.name.localeCompare(b.name) || a.path.localeCompare(b.path)
  );
  return discovered;
}

/**
 * Explicit configuration wins by both canonical path and repo name. Discovery
 * fills in every other checkout in the approved roots.
 */
export function mergeConfiguredAndDiscoveredRepos(
  configured: RepoConfig[],
  roots: string[],
): RepoConfig[] {
  const normalized = configured.map((repo) => ({
    ...repo,
    path: normalizePath(repo.path).replace(/\/+$/, ""),
  }));
  const configuredNames = new Set(
    normalized.map((repo) => repo.name.toLowerCase()),
  );
  const configuredPaths = new Set(
    normalized.map((repo) => safeRealpath(repo.path) ?? repo.path),
  );

  const discovered = discoverLocalRepos(roots).filter((repo) =>
    !configuredNames.has(repo.name.toLowerCase()) &&
    !configuredPaths.has(repo.path)
  );
  assertUniqueNames(discovered);

  return [...normalized, ...discovered];
}

function isPrimaryGitCheckout(path: string): boolean {
  try {
    return lstatSync(join(path, ".git")).isDirectory();
  } catch {
    return false;
  }
}

function detectDefaultBase(path: string): string | null {
  const symbolic = git(path, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  if (symbolic?.startsWith("origin/")) return symbolic;

  for (const candidate of DEFAULT_BASE_CANDIDATES) {
    if (git(path, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`])) {
      return candidate;
    }
  }
  return null;
}

function detectSetupCommand(path: string): string | null {
  const relative = "scripts/setup-worktree.sh";
  try {
    accessSync(join(path, relative), constants.X_OK);
    return relative;
  } catch {
    return null;
  }
}

function git(cwd: string, args: string[]): string | null {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return null;
  const output = result.stdout.trim();
  return output || null;
}

function normalizePath(path: string): string {
  const expanded = path === "~"
    ? homedir()
    : path.startsWith("~/")
      ? join(homedir(), path.slice(2))
      : path;
  return resolve(expanded);
}

function safeRealpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function assertUniqueNames(repos: RepoConfig[]): void {
  const byName = new Map<string, string[]>();
  for (const repo of repos) {
    const key = repo.name.toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), repo.path]);
  }
  const collisions = [...byName.entries()].filter(([, paths]) => paths.length > 1);
  if (collisions.length === 0) return;

  const details = collisions
    .map(([name, paths]) => `${name}: ${paths.join(", ")}`)
    .join("; ");
  throw new Error(
    `REPO_DISCOVERY_ROOTS contains duplicate repository names; configure an explicit unique root or REPOS entry: ${details}`,
  );
}
