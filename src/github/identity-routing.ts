import type { RepoConfig } from "../config.ts";
import { repoMatchesRef } from "../worktree/review-routing.ts";

/**
 * Coordinates a request explicitly names: a GitHub URL, or a `gh`-style
 * `--repo`/`-R` argument. Deliberately narrower than prose — a bare repo name
 * mentioned in passing must not select an identity.
 */
function githubCoordinates(prompt: string): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  const patterns = [
    /https?:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)/gi,
    /(?:^|\s)(?:--repo|-R)\s+([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of prompt.matchAll(pattern)) {
      const owner = match[1];
      const repo = match[2]?.replace(/\.git$/i, "");
      if (!owner || !repo) continue;
      const ref = `${owner}/${repo}`;
      const key = ref.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push(ref);
    }
  }
  return refs;
}

/**
 * Choose the repository an invocation authenticates with. A durable binding
 * wins; otherwise the request must name exactly one configured repository.
 *
 * Coordinates matching no configured repo are ignored rather than failing the
 * whole resolution: an incidental upstream link alongside the target must not
 * strip credentials and reproduce the unbound-identity failure.
 */
export function resolveIdentityRepoName(input: {
  targetRepoName?: string | null;
  durableIdentityRepo?: string | null;
  repos: RepoConfig[];
  prompt: string;
}): string | undefined {
  if (input.targetRepoName) return input.targetRepoName;
  const coordinates = githubCoordinates(input.prompt);
  if (coordinates.length > 0) {
    const named = input.repos.filter((repo) =>
      coordinates.some((ref) => repoMatchesRef(repo, ref)),
    );
    // Two configured repos named at once is ambiguous: refuse rather than pick.
    if (named.length > 1) return undefined;
    if (named.length === 1) return named[0]!.name;
  }
  // No configured coordinate in this turn (a follow-up "go ahead", or only an
  // unrelated link), so the thread keeps the identity it already bound.
  return input.durableIdentityRepo ?? undefined;
}

/** The configured repository an invocation authenticates with, if any. */
export function resolveIdentityRepo(input: {
  targetRepoName?: string | null;
  durableIdentityRepo?: string | null;
  repos: RepoConfig[];
  prompt: string;
}): RepoConfig | undefined {
  const name = resolveIdentityRepoName(input);
  return name ? input.repos.find((repo) => repo.name === name) : undefined;
}
