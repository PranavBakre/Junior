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
  const urlMatches = repos.filter((repo) => {
    const escaped = escapeRegExp(repo.name);
    return new RegExp(
      `github\\.com/[^/\\s]+/${escaped}(?:\\.git)?(?:/|\\s|$)`,
      "i",
    ).test(prompt);
  });
  if (urlMatches.length === 1) return urlMatches[0];

  const refMatches = repos.filter((repo) =>
    pipelineRepoRefs.some((ref) => repoMatchesRef(repo.name, ref)),
  );
  return refMatches.length === 1 ? refMatches[0] : undefined;
}

function repoMatchesRef(repoName: string, ref: string): boolean {
  const normalized = ref.trim().replace(/\.git$/i, "").replace(/\/+$/, "");
  return (
    normalized.toLowerCase() === repoName.toLowerCase() ||
    normalized.toLowerCase().endsWith(`/${repoName.toLowerCase()}`)
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

