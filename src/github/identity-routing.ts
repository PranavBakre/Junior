import type { RepoConfig } from "../config.ts";
import { inferReviewRepo } from "../worktree/review-routing.ts";

/**
 * Choose the repository an invocation authenticates with. A durable binding
 * wins; with none, only an explicit PR URL is strong enough to bind against —
 * ordinary prose and incidental URLs must not select an identity.
 */
export function resolveIdentityRepoName(input: {
  targetRepoName?: string | null;
  repos: RepoConfig[];
  prompt: string;
}): string | undefined {
  if (input.targetRepoName) return input.targetRepoName;
  return inferReviewRepo(input.repos, input.prompt)?.name;
}
