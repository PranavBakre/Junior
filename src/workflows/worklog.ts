import type { RepoConfig } from "../config.ts";

export interface WorklogCommit {
  repo: string;
  hash: string;
  shortHash: string;
  date: string;
  subject: string;
}

export interface WorklogPr {
  repo: string;
  number: number;
  title: string;
  state: string;
  url: string;
  updatedAt: string;
  createdAt?: string;
  mergedAt?: string | null;
  headRefName?: string;
  baseRefName?: string;
}

export interface WorklogActivity {
  generatedAt: string;
  since: string;
  until: string;
  repos: string[];
  commits: WorklogCommit[];
  prs: WorklogPr[];
  errors: string[];
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type RunCommand = (
  command: string,
  args: string[],
  cwd: string,
) => Promise<CommandResult>;

export interface CollectWorklogOptions {
  repos: RepoConfig[];
  since: Date;
  until?: Date;
  runCommand?: RunCommand;
}

export async function collectWorklogActivity(
  options: CollectWorklogOptions,
): Promise<WorklogActivity> {
  const until = options.until ?? new Date();
  const runCommand = options.runCommand ?? runCommandDefault;
  const activity: WorklogActivity = {
    generatedAt: until.toISOString(),
    since: options.since.toISOString(),
    until: until.toISOString(),
    repos: options.repos.map((repo) => repo.name),
    commits: [],
    prs: [],
    errors: [],
  };

  for (const repo of options.repos) {
    try {
      activity.commits.push(
        ...(await collectCommits(repo, options.since, runCommand)),
      );
    } catch (err) {
      activity.errors.push(formatRepoError(repo.name, "git log", err));
    }

    try {
      activity.prs.push(
        ...(await collectPullRequests(repo, options.since, runCommand)),
      );
    } catch (err) {
      activity.errors.push(formatRepoError(repo.name, "gh pr list", err));
    }
  }

  return activity;
}

export function formatWorklogSlackSummary(activity: WorklogActivity): string {
  const lines = ["*Worklog* :white_check_mark:"];
  const groups = groupActivity(activity);
  if (groups.size === 0) lines.push("> No tracked PR or commit activity");

  for (const [repo, group] of groups) {
    lines.push(`> ${repo}`);
    for (const pr of group.prs.slice(0, 6)) {
      lines.push(`- ${prSummary(pr)}`);
    }
    const commits = group.commits.slice(0, 6);
    if (commits.length > 0) {
      lines.push("- Commits");
      for (const commit of commits) {
        lines.push(`  - ${cleanSubject(commit.subject)} (${commit.shortHash})`);
      }
    }
  }

  if (activity.errors.length > 0) {
    lines.push("> Collection notes");
    for (const error of activity.errors.slice(0, 4)) {
      lines.push(`- ${error}`);
    }
  }

  return lines.join("\n");
}

export function renderWorklogArtifact(
  activity: WorklogActivity,
  summary: string,
): string {
  const lines = [
    "## Worklog Activity",
    "",
    `Window: ${activity.since} to ${activity.until}`,
    "",
    "## Summary",
    "",
    summary,
    "",
    "## Pull Requests",
    "",
  ];
  if (activity.prs.length === 0) {
    lines.push("_No PR activity found._");
  } else {
    for (const pr of activity.prs) {
      lines.push(`- [${pr.repo}#${pr.number}](${pr.url}) ${pr.title} (${pr.state}, updated ${pr.updatedAt})`);
    }
  }
  lines.push("", "## Commits", "");
  if (activity.commits.length === 0) {
    lines.push("_No commits found._");
  } else {
    for (const commit of activity.commits) {
      lines.push(`- ${commit.repo} ${commit.shortHash} ${commit.subject} (${commit.date})`);
    }
  }
  if (activity.errors.length > 0) {
    lines.push("", "## Collection Errors", "");
    for (const error of activity.errors) lines.push(`- ${error}`);
  }
  return lines.join("\n");
}

async function collectCommits(
  repo: RepoConfig,
  since: Date,
  runCommand: RunCommand,
): Promise<WorklogCommit[]> {
  const author = await detectGitAuthor(repo.path, runCommand);
  const args = [
    "log",
    `--since=${since.toISOString()}`,
    "--date=iso-strict",
    "--pretty=format:%H%x1f%h%x1f%ad%x1f%s",
  ];
  if (author) args.splice(2, 0, `--author=${author}`);

  const result = await runCommand("git", args, repo.path);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `git exited ${result.exitCode}`);
  }
  if (!result.stdout.trim()) return [];
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, shortHash, date, subject] = line.split("\x1f");
      return { repo: repo.name, hash, shortHash, date, subject };
    });
}

async function collectPullRequests(
  repo: RepoConfig,
  since: Date,
  runCommand: RunCommand,
): Promise<WorklogPr[]> {
  const remote = await runCommand("git", ["remote", "get-url", "origin"], repo.path);
  if (remote.exitCode !== 0) {
    throw new Error(remote.stderr || `git remote exited ${remote.exitCode}`);
  }
  const slug = parseGithubSlug(remote.stdout.trim());
  if (!slug) return [];
  const user = await detectGithubUser(repo.path, runCommand);

  const result = await runCommand(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      slug,
      "--author",
      user,
      "--state",
      "all",
      "--search",
      `updated:>=${since.toISOString().slice(0, 10)}`,
      "--limit",
      "50",
      "--json",
      "number,title,state,url,updatedAt,createdAt,mergedAt,headRefName,baseRefName",
    ],
    repo.path,
  );
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `gh exited ${result.exitCode}`);
  }
  if (!result.stdout.trim()) return [];

  const parsed = JSON.parse(result.stdout) as Array<Omit<WorklogPr, "repo">>;
  return parsed.map((pr) => ({ ...pr, repo: repo.name }));
}

async function detectGitAuthor(cwd: string, runCommand: RunCommand): Promise<string | null> {
  for (const key of ["user.email", "user.name"]) {
    const result = await runCommand("git", ["config", "--get", key], cwd);
    if (result.exitCode === 0 && result.stdout.trim()) {
      return result.stdout.trim();
    }
  }
  return null;
}

async function detectGithubUser(cwd: string, runCommand: RunCommand): Promise<string> {
  const result = await runCommand("gh", ["api", "user", "--jq", ".login"], cwd);
  if (result.exitCode !== 0 || !result.stdout.trim()) {
    throw new Error(result.stderr || `gh api user exited ${result.exitCode}`);
  }
  return result.stdout.trim();
}

export function parseGithubSlug(remoteUrl: string): string | null {
  const normalized = remoteUrl.replace(/\.git$/, "");
  const ssh = normalized.match(/^git@github\.com:([^/]+)\/([^/]+)$/);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  const https = normalized.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/);
  if (https) return `${https[1]}/${https[2]}`;
  return null;
}

async function runCommandDefault(
  command: string,
  args: string[],
  cwd: string,
): Promise<CommandResult> {
  const proc = Bun.spawn([command, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

interface ActivityGroup {
  prs: WorklogPr[];
  commits: WorklogCommit[];
}

function groupActivity(activity: WorklogActivity): Map<string, ActivityGroup> {
  const groups = new Map<string, ActivityGroup>();
  for (const pr of activity.prs) getGroup(groups, labelRepo(pr.repo)).prs.push(pr);
  for (const commit of activity.commits) getGroup(groups, labelRepo(commit.repo)).commits.push(commit);
  return groups;
}

function getGroup(groups: Map<string, ActivityGroup>, key: string): ActivityGroup {
  let group = groups.get(key);
  if (!group) {
    group = { prs: [], commits: [] };
    groups.set(key, group);
  }
  return group;
}

function prSummary(pr: WorklogPr): string {
  const state = pr.mergedAt ? "merged" : pr.state.toLowerCase();
  const suffix = pr.mergedAt ? " :white_check_mark:" : "";
  return `${cleanSubject(pr.title)} (${state} PR #${pr.number})${suffix}`;
}

function cleanSubject(subject: string): string {
  return subject
    .replace(/^merge pull request #\d+ from \S+\s*/i, "")
    .replace(/^\w+\([^)]+\):\s*/, "")
    .replace(/^\w+:\s*/, "")
    .trim();
}

function labelRepo(repo: string): string {
  return repo
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatRepoError(repo: string, step: string, err: unknown): string {
  return `${repo} ${step}: ${err instanceof Error ? err.message : String(err)}`;
}
