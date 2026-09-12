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
    /(?:^|\s)--repo[=\s]+([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)/gi,
    /(?:^|\s)-R[=\s]?([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of prompt.matchAll(pattern)) {
      const owner = match[1];
      // A bare repo URL ending a sentence otherwise captures "gx-backend." and
      // matches no configured repo, silently resolving no identity. Only `.`
      // can reach this — the capture class already excludes the other
      // punctuation — so widening the capture class means widening this too.
      const repo = match[2]
        ?.replace(/\.+$/, "")
        .replace(/\.git$/i, "");
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
 * True when the request itself names a GitHub coordinate — i.e. this turn
 * depends on the identity rather than merely inheriting one.
 */
export function promptNamesRepoCoordinate(prompt: string): boolean {
  return githubCoordinates(prompt).length > 0;
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
    // Two configured repos named at once is ambiguous about the task, not about
    // the thread's identity. Keep the binding it already holds rather than
    // stripping credentials for the turn: the token is account-wide, so
    // refusing buys no containment and only blinds the agent.
    if (named.length > 1) return input.durableIdentityRepo ?? undefined;
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
