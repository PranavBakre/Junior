import type { RepoConfig } from "../config.ts";
import { inferReviewRepo, repoMatchesRef } from "./review-routing.ts";

export type PipelineRepoResolution = {
  repos: RepoConfig[];
  unresolvedRefs: string[];
};

/**
 * Resolve durable pipeline repo refs to configured repositories while
 * preserving the run's order. Unknown refs are returned explicitly so callers
 * can fail closed instead of falling back to a developer checkout.
 */
export function resolvePipelineRepos(
  repos: RepoConfig[],
  repoRefs: string[],
): PipelineRepoResolution {
  const resolved: RepoConfig[] = [];
  const unresolvedRefs: string[] = [];
  const seen = new Set<string>();

  for (const ref of repoRefs) {
    const matches = repos.filter((repo) => repoMatchesRef(repo.name, ref));
    if (matches.length !== 1) {
      unresolvedRefs.push(ref);
      continue;
    }
    const repo = matches[0]!;
    if (!seen.has(repo.name)) {
      seen.add(repo.name);
      resolved.push(repo);
    }
  }

  return { repos: resolved, unresolvedRefs };
}

/**
 * Pick the pipeline worktree used as the process cwd. Every resolved repo gets
 * its own worktree; this only chooses the initial checkout. Explicit PR URLs
 * win, then assignment workstream/agent affinity, then durable repo order.
 */
export function inferPipelinePrimaryRepo(input: {
  configuredRepos: RepoConfig[];
  pipelineRepos: RepoConfig[];
  prompt: string;
  targetAgent: string;
  assignmentContextRefs?: string[];
}): RepoConfig | undefined {
  const explicit = inferReviewRepo(input.configuredRepos, input.prompt);
  if (
    explicit &&
    input.pipelineRepos.some((repo) => repo.name === explicit.name)
  ) {
    return explicit;
  }

  const workstream = input.assignmentContextRefs
    ?.find((ref) => ref.startsWith("workstream:"))
    ?.slice("workstream:".length)
    .trim()
    .toLowerCase();
  const affinity = workstream || agentWorkstream(input.targetAgent);
  if (affinity) {
    const matches = input.pipelineRepos.filter((repo) =>
      repoMatchesWorkstream(repo.name, affinity)
    );
    if (matches.length === 1) return matches[0];
  }

  return input.pipelineRepos[0];
}

function agentWorkstream(agent: string): "backend" | "frontend" | null {
  if (agent === "frontend") return "frontend";
  if (agent === "build") return "backend";
  return null;
}

function repoMatchesWorkstream(repoName: string, workstream: string): boolean {
  const normalized = repoName.toLowerCase();
  if (workstream === "frontend") {
    return /(?:^|[-_/])(client|frontend|web|admin|expo|next)(?:$|[-_/])/.test(
      normalized,
    );
  }
  if (workstream === "backend") {
    return /(?:^|[-_/])(backend|api|service|server)(?:$|[-_/])/.test(
      normalized,
    );
  }
  return false;
}
