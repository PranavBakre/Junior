import type { RepoConfig } from "../config.ts";
import { chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GITHUB_USER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,38}$/;

export interface GitHubCommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type GitHubCommandRunner = (
  args: string[],
  env: Record<string, string>,
) => Promise<GitHubCommandResult>;

/**
 * Resolves the configured GitHub identity without changing global `gh` state.
 * Successful account/token verification is cached for the process lifetime.
 */
export class GitHubAuthResolver {
  private readonly reposByGitHubRef: Map<string, RepoConfig>;
  private readonly reposByName: Map<string, RepoConfig>;
  private readonly verifiedTokens = new Map<string, string>();
  private readonly runCommand: GitHubCommandRunner;

  constructor(
    repos: readonly RepoConfig[],
    runCommand: GitHubCommandRunner = runGitHubCommand,
  ) {
    this.reposByGitHubRef = new Map(
      repos
        .filter((repo) => repo.githubRepo)
        .map((repo) => [normalizeRepoRef(repo.githubRepo!), repo]),
    );
    this.reposByName = new Map(repos.map((repo) => [repo.name, repo]));
    this.runCommand = runCommand;
  }

  async environmentForRepoName(
    repoName: string,
  ): Promise<Record<string, string> | undefined> {
    const repo = this.reposByName.get(repoName);
    return repo ? this.environmentForRepo(repo) : undefined;
  }

  async environmentForRepoRef(
    repoRef: string,
  ): Promise<Record<string, string>> {
    const repo = this.reposByGitHubRef.get(normalizeRepoRef(repoRef));
    if (!repo) {
      throw new Error(`No GitHub identity is configured for repository ${repoRef}`);
    }
    const environment = await this.environmentForRepo(repo);
    if (!environment) {
      throw new Error(
        `Repository ${repo.name} must configure githubUser for GitHub operations`,
      );
    }
    return environment;
  }

  async environmentForRepo(
    repo: RepoConfig,
  ): Promise<Record<string, string> | undefined> {
    const configuredUser = repo.githubUser?.trim();
    if (!configuredUser) return undefined;
    if (!repo.githubRepo?.trim()) {
      throw new Error(
        `Repository ${repo.name} must configure githubRepo with githubUser for GitHub operations`,
      );
    }
    if (!GITHUB_USER_PATTERN.test(configuredUser)) {
      throw new Error(
        `Invalid githubUser "${configuredUser}" for repo ${repo.name}`,
      );
    }

    const token = await this.tokenForUser(configuredUser, repo.name);
    // GH_TOKEN is intentionally explicit for this child process. An empty,
    // Junior-owned gh config prevents a selected token from falling back to
    // whichever account happens to be active in the host's GH_CONFIG_DIR.
    return {
      GH_TOKEN: token,
      GH_PROMPT_DISABLED: "1",
      GH_CONFIG_DIR: isolatedGitHubConfigDir(),
    };
  }

  private async tokenForUser(user: string, repoName: string): Promise<string> {
    const key = user.toLowerCase();
    const cached = this.verifiedTokens.get(key);
    if (cached) return cached;

    const tokenResult = await this.runCommand(
      ["auth", "token", "--user", user],
      cleanGitHubEnvironment(),
    );
    if (tokenResult.status !== 0) {
      throw new Error(
        `GitHub user ${user} is not available for repo ${repoName}: ${commandError(tokenResult)}`,
      );
    }
    const token = tokenResult.stdout.trim();
    if (!token || /\s/.test(token)) {
      throw new Error(`GitHub user ${user} returned no usable token for repo ${repoName}`);
    }

    const identityResult = await this.runCommand(
      ["api", "user", "--jq", ".login"],
      { ...cleanGitHubEnvironment(), GH_TOKEN: token },
    );
    const resolvedUser = identityResult.stdout.trim();
    if (identityResult.status !== 0 || resolvedUser.toLowerCase() !== key) {
      throw new Error(
        `GitHub identity mismatch for repo ${repoName}: configured ${user}, resolved ${resolvedUser || commandError(identityResult)}`,
      );
    }

    this.verifiedTokens.set(key, token);
    return token;
  }
}

export function normalizeRepoRef(value: string): string {
  return value.trim().replace(/\.git$/i, "").toLowerCase();
}

export function cleanGitHubEnvironment(options: {
  isolatedConfig?: boolean;
} = {}): Record<string, string> {
  const env = { ...(process.env as Record<string, string>) };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.GH_ENTERPRISE_TOKEN;
  delete env.GITHUB_RECONCILE_TOKEN;
  delete env.GH_CONFIG_DIR;
  delete env.GH_HOST;
  delete env.GH_REPO;
  if (options.isolatedConfig) {
    env.GH_CONFIG_DIR = isolatedGitHubConfigDir();
  }
  env.GH_PROMPT_DISABLED = "1";
  return env;
}

/**
 * Keep every gh child that already has an explicitly verified GH_TOKEN away
 * from the host-wide gh account database. The directory contains no tokens;
 * its only purpose is to make ambient account selection impossible.
 */
function isolatedGitHubConfigDir(): string {
  const directory = join(tmpdir(), `junior-gh-isolated-${process.pid}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  return directory;
}

async function runGitHubCommand(
  args: string[],
  env: Record<string, string>,
): Promise<GitHubCommandResult> {
  const proc = Bun.spawn(["gh", ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { status, stdout, stderr };
}

function commandError(result: GitHubCommandResult): string {
  return (result.stderr || result.stdout).trim().replace(/[\r\n]+/g, " ").slice(0, 300) ||
    `gh exited with status ${result.status}`;
}
