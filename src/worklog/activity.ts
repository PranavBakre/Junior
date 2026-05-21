import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  gitAuthor?: string | null;
  githubUser?: string | null;
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
    const gitAuthor =
      options.gitAuthor ?? (await detectGitAuthor(repo.path, runCommand));
    try {
      activity.commits.push(
        ...(await collectCommits(repo, options.since, gitAuthor, runCommand)),
      );
    } catch (err) {
      activity.errors.push(formatRepoError(repo.name, "git log", err));
    }

    try {
      activity.prs.push(
        ...(await collectPullRequests(repo, options.since, options.githubUser, runCommand)),
      );
    } catch (err) {
      activity.errors.push(formatRepoError(repo.name, "gh pr list", err));
    }
  }

  return activity;
}

export async function writeWorklogDoc(
  activity: WorklogActivity,
  docsDir: string,
  slackSummary: string,
): Promise<string> {
  await mkdir(docsDir, { recursive: true });
  const date = activity.until.slice(0, 10);
  const path = join(docsDir, `${date}.md`);
  await writeFile(path, renderWorklogMarkdown(activity, slackSummary), "utf8");
  return path;
}

export function renderWorklogMarkdown(
  activity: WorklogActivity,
  slackSummary: string,
): string {
  const lines = [
    `# Worklog ${activity.until.slice(0, 10)}`,
    "",
    `Generated: ${activity.generatedAt}`,
    `Window: ${activity.since} to ${activity.until}`,
    "",
    "## Slack Summary",
    "",
    slackSummary.trim() || "_No summary generated._",
    "",
    "## Pull Requests",
    "",
  ];

  if (activity.prs.length === 0) {
    lines.push("_No PR activity found._");
  } else {
    for (const pr of activity.prs) {
      lines.push(
        `- [${pr.repo}#${pr.number}](${pr.url}) ${pr.title} (${pr.state}, updated ${pr.updatedAt})`,
      );
    }
  }

  lines.push("", "## Commits", "");
  if (activity.commits.length === 0) {
    lines.push("_No commits found._");
  } else {
    for (const commit of activity.commits) {
      lines.push(
        `- ${commit.repo} ${commit.shortHash} ${commit.subject} (${commit.date})`,
      );
    }
  }

  if (activity.errors.length > 0) {
    lines.push("", "## Collection Errors", "");
    for (const error of activity.errors) {
      lines.push(`- ${error}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

async function collectCommits(
  repo: RepoConfig,
  since: Date,
  gitAuthor: string | null,
  runCommand: RunCommand,
): Promise<WorklogCommit[]> {
  const args = [
    "log",
    `--since=${since.toISOString()}`,
    "--date=iso-strict",
    "--pretty=format:%H%x1f%h%x1f%ad%x1f%s",
  ];
  if (gitAuthor) args.splice(2, 0, `--author=${gitAuthor}`);

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
      return {
        repo: repo.name,
        hash,
        shortHash,
        date,
        subject,
      };
    });
}

async function collectPullRequests(
  repo: RepoConfig,
  since: Date,
  githubUser: string | null | undefined,
  runCommand: RunCommand,
): Promise<WorklogPr[]> {
  const remote = await runCommand("git", ["remote", "get-url", "origin"], repo.path);
  if (remote.exitCode !== 0) {
    throw new Error(remote.stderr || `git remote exited ${remote.exitCode}`);
  }
  const slug = parseGithubSlug(remote.stdout.trim());
  if (!slug) return [];

  const author = githubUser ?? (await detectGithubUser(repo.path, runCommand));
  if (!author) return [];
  const result = await runCommand(
    "gh",
    [
      "pr",
      "list",
      "--repo",
      slug,
      "--author",
      author,
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

async function detectGithubUser(
  cwd: string,
  runCommand: RunCommand,
): Promise<string | null> {
  const result = await runCommand("gh", ["api", "user", "--jq", ".login"], cwd);
  if (result.exitCode === 0 && result.stdout.trim()) {
    return result.stdout.trim();
  }
  throw new Error(result.stderr || `gh api user exited ${result.exitCode}`);
}

async function detectGitAuthor(
  cwd: string,
  runCommand: RunCommand,
): Promise<string | null> {
  for (const key of ["user.email", "user.name"]) {
    const result = await runCommand("git", ["config", "--get", key], cwd);
    if (result.exitCode === 0 && result.stdout.trim()) {
      return result.stdout.trim();
    }
  }
  return null;
}

export function parseGithubSlug(remoteUrl: string): string | null {
  const match =
    remoteUrl.match(/^git@github\.com:([^/]+\/[^/.]+)(?:\.git)?$/) ??
    remoteUrl.match(/^https:\/\/github\.com\/([^/]+\/[^/.]+)(?:\.git)?$/);
  return match?.[1] ?? null;
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

function formatRepoError(repo: string, step: string, err: unknown): string {
  return `${repo} ${step}: ${err instanceof Error ? err.message : String(err)}`;
}
