import type { RepoConfig } from "../config.ts";

/**
 * Resolve the repository a review turn is about without guessing from ordinary
 * prose. An explicit GitHub URL wins; a pipeline repo ref is used only when it
 * resolves to exactly one configured repository.
 */
export function inferReviewRepo(
  repos: RepoConfig[],
  prompt: string,
  pipelineRepoRefs: string[] = [],
): RepoConfig | undefined {
  const urlResolution = resolveReviewRepos(repos, prompt);
  if (urlResolution.repoRefs.length > 0) {
    if (
      urlResolution.unresolvedRefs.length > 0 ||
      urlResolution.ambiguousRefs.length > 0 ||
      urlResolution.repos.length !== 1
    ) return undefined;
    return urlResolution.repos[0];
  }

  const refMatches = repos.filter((repo) =>
    pipelineRepoRefs.some((ref) => repoMatchesRef(repo, ref)),
  );
  return refMatches.length === 1 ? refMatches[0] : undefined;
}

/** Return every configured repository explicitly referenced by a GitHub URL. */
export function inferReviewRepos(
  repos: RepoConfig[],
  prompt: string,
): RepoConfig[] {
  const resolution = resolveReviewRepos(repos, prompt);
  if (
    resolution.unresolvedRefs.length > 0 ||
    resolution.ambiguousRefs.length > 0
  ) return [];
  return resolution.repos;
}

export interface ReviewRepoResolution {
  /** Every distinct PR `owner/repo` coordinate in first-appearance order. */
  repoRefs: string[];
  repos: RepoConfig[];
  unresolvedRefs: string[];
  ambiguousRefs: string[];
}

/** Parse and resolve every GitHub PR coordinate; never silently drop a URL. */
export function resolveReviewRepos(
  repos: RepoConfig[],
  prompt: string,
): ReviewRepoResolution {
  const repoRefs = reviewRepoRefs(prompt);
  const resolved: RepoConfig[] = [];
  const unresolvedRefs: string[] = [];
  const ambiguousRefs: string[] = [];

  for (const ref of repoRefs) {
    const matches = repos.filter((repo) => repoMatchesRef(repo, ref));
    if (matches.length === 0) {
      unresolvedRefs.push(ref);
    } else if (matches.length > 1) {
      ambiguousRefs.push(ref);
    } else if (!resolved.some((repo) => repo.name === matches[0]!.name)) {
      resolved.push(matches[0]!);
    }
  }
  return { repoRefs, repos: resolved, unresolvedRefs, ambiguousRefs };
}

export function reviewRepoRefs(prompt: string): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  const pattern = /https?:\/\/github\.com\/([^/\s<>]+)\/([^/\s<>]+)\/pull\/\d+\b/gi;
  for (const match of prompt.matchAll(pattern)) {
    const owner = match[1]?.trim();
    const repo = match[2]?.trim().replace(/\.git$/i, "");
    if (!owner || !repo) continue;
    const ref = `${owner}/${repo}`;
    const key = ref.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}

export function repoMatchesRef(repo: RepoConfig, ref: string): boolean {
  const normalized = ref.trim().replace(/\.git$/i, "").replace(/\/+$/, "");
  if (!normalized.includes("/")) {
    return normalized.toLowerCase() === repo.name.toLowerCase();
  }
  return Boolean(
    repo.githubRepo &&
      normalized.toLowerCase() === repo.githubRepo.toLowerCase(),
  );
}
