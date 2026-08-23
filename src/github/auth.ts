import type { RepoConfig } from "../config.ts";

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
    this.runCommand = runCommand;
  }

  async environmentForRepoName(
    repoName: string,
  ): Promise<Record<string, string> | undefined> {
    const repo = [...this.reposByGitHubRef.values()].find(
      (candidate) => candidate.name === repoName,
    );
    return repo ? this.environmentForRepo(repo) : undefined;
  }

  async environmentForRepoRef(
    repoRef: string,
  ): Promise<Record<string, string> | undefined> {
    const repo = this.reposByGitHubRef.get(normalizeRepoRef(repoRef));
    return repo ? this.environmentForRepo(repo) : undefined;
  }

  async environmentForRepo(
    repo: RepoConfig,
  ): Promise<Record<string, string> | undefined> {
    const configuredUser = repo.githubUser?.trim();
    if (!configuredUser) return undefined;
    if (!GITHUB_USER_PATTERN.test(configuredUser)) {
      throw new Error(
        `Invalid githubUser "${configuredUser}" for repo ${repo.name}`,
      );
    }

    const token = await this.tokenForUser(configuredUser, repo.name);
    // GH_TOKEN is intentionally explicit for this child process. Remove
    // inherited GITHUB_TOKEN at the call site so it cannot override it.
    return {
      GH_TOKEN: token,
      GH_PROMPT_DISABLED: "1",
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

export function cleanGitHubEnvironment(): Record<string, string> {
  const env = { ...(process.env as Record<string, string>) };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.GH_ENTERPRISE_TOKEN;
  env.GH_PROMPT_DISABLED = "1";
  return env;
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
