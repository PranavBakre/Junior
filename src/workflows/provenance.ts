import { relative, resolve } from "node:path";
import { realpathSync } from "node:fs";
import type { WorkflowSourceRoot } from "./types.ts";

/**
 * Git provenance for a workflow definition. `commitSha` is the commit at the
 * configured default ref whose tree was verified, not the current checkout's
 * HEAD. This keeps a feature-branch or dirty working tree from becoming an
 * operational workflow by accident.
 */
export interface WorkflowProvenance {
  status: "verified";
  repoPath: string;
  defaultRef: string;
  commitSha: string;
  blobSha: string;
}

export type WorkflowProvenanceResult =
  | WorkflowProvenance
  | { status: "unpublished"; reason: string };

export interface VerifyWorkflowProvenanceOptions {
  path: string;
  sourceRoot: WorkflowSourceRoot;
  /** Ref naming the repository's default branch, normally origin/main. */
  defaultRef?: string;
}

/**
 * Verify that the on-disk workflow is exactly the blob published at the
 * repository's default ref. A missing ref/path, an untracked file, or any
 * working-tree edit is unpublished and must not be scheduled.
 */
export async function verifyWorkflowProvenance(
  options: VerifyWorkflowProvenanceOptions,
): Promise<WorkflowProvenanceResult> {
  void options.sourceRoot;
  const filePath = realpathSync(resolve(options.path));
  const defaultRef = options.defaultRef ?? "origin/main";

  try {
    const repoPath = (await git(resolve(filePath, ".."), ["rev-parse", "--show-toplevel"])).trim();
    const canonicalRepoPath = realpathSync(repoPath);
    if (!canonicalRepoPath) return unpublished("workflow repository is not available");
    const relativePath = relative(canonicalRepoPath, filePath).replaceAll("\\", "/");
    if (!relativePath || relativePath.startsWith("../") || relativePath === "..") {
      return unpublished("workflow path is outside its Git repository");
    }
    const commitSha = (await git(canonicalRepoPath, ["rev-parse", "--verify", `${defaultRef}^{commit}`])).trim();
    if (!commitSha) return unpublished(`default branch ref ${defaultRef} is unavailable`);
    const status = (await git(canonicalRepoPath, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--",
      relativePath,
    ])).trim();
    if (status) return unpublished(`working-tree or index is dirty for ${relativePath}`);
    const blobSha = (await git(canonicalRepoPath, ["rev-parse", "--verify", `${commitSha}:${relativePath}`])).trim();
    if (!blobSha) return unpublished(`workflow is not published at ${defaultRef}`);
    const workingBlobSha = (await git(canonicalRepoPath, ["hash-object", "--", relativePath])).trim();
    if (workingBlobSha !== blobSha) {
      return unpublished(`working-tree definition differs from ${defaultRef}`);
    }
    return { status: "verified", repoPath: canonicalRepoPath, defaultRef, commitSha, blobSha };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return unpublished(detail || `unable to verify default branch ref ${defaultRef}`);
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const process = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  const exitCode = await process.exited;
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `git ${args.join(" ")} failed (${exitCode})`);
  }
  return stdout;
}

function unpublished(reason: string): WorkflowProvenanceResult {
  return { status: "unpublished", reason };
}
