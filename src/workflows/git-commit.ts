import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import type { RepoConfig } from "../config.ts";
import {
  hashWorkflowContent,
  validateWorkflowMarkdown,
} from "./definition.ts";
import {
  OVERLAY_WORKFLOW_ROOT,
  PUBLIC_WORKFLOW_ROOT,
  type WorkflowSourceRoot,
} from "./types.ts";

export const DASHBOARD_GIT_NAME = "Junior Dashboard";
export const DASHBOARD_GIT_EMAIL = "junior-dashboard@localhost";

const CONFLICT_CODES = new Set(["UU", "AA", "DD", "AU", "UA"]);

export type WorkflowGitCommitCode =
  | "not-a-repo"
  | "path-outside-repo"
  | "detached-head"
  | "merging"
  | "rebasing"
  | "unresolved-conflicts"
  | "nothing-to-commit"
  | "git-failed";

export type WorkflowGitCommitResult =
  | { ok: true; sha: string; branch: string; stagedOnly: string[] }
  | { ok: false; code: WorkflowGitCommitCode; detail: string };

export type WorkflowGitStatus = {
  sha: string | null;
  branch: string | null;
  detached: boolean;
  dirty: boolean;
  merging: boolean;
  rebasing: boolean;
};

export type WorkflowGitCommitInput = {
  repoRoot: string;
  allowedRoots: string[];
  relativePath: string;
  markdown: string;
  message: string;
  requireNamedBranch?: boolean;
  repos?: RepoConfig[];
  builtInCommands?: Set<string>;
  sourceRoot?: WorkflowSourceRoot;
};

export type DashboardWorkflowWriteInput = {
  projectRoot: string;
  sourceRoot: WorkflowSourceRoot;
  name: string;
  markdown: string;
  message: string;
  parentMessage?: string;
  actor?: string;
  repos: RepoConfig[];
  builtInCommands?: Set<string>;
};

export type DashboardWorkflowWriteResult =
  | {
      ok: true;
      name: string;
      sourcePath: string;
      sourceRoot: WorkflowSourceRoot;
      versionHash: string;
      overlayCommitted: boolean;
      commit: {
        sha: string;
        branch: string;
        repo: "junior" | "agents-org";
        stat: string;
      };
      parentPointerCommitted?: boolean;
      parentPointer?:
        | { sha: string; branch: string; stat: string }
        | { code: string; detail: string };
    }
  | { ok: false; code: WorkflowGitCommitCode | "overlay-root-missing"; detail: string };

export function workflowSourcePath(
  sourceRoot: WorkflowSourceRoot,
  name: string,
): string {
  const file = `${name}.workflow.md`;
  return sourceRoot === "overlay"
    ? `${OVERLAY_WORKFLOW_ROOT}/${file}`
    : `${PUBLIC_WORKFLOW_ROOT}/${file}`;
}

export function overlayWorkflowsRootExists(projectRoot: string): boolean {
  try {
    return existsSync(join(projectRoot, OVERLAY_WORKFLOW_ROOT));
  } catch {
    return false;
  }
}

export function allowedGitRoots(projectRoot: string): string[] {
  const roots = [existingRealpath(projectRoot)];
  const overlay = join(projectRoot, "agents-org");
  if (existsSync(overlay)) roots.push(existingRealpath(overlay));
  return roots;
}

export async function probeWorkflowRepo(
  repoRoot: string,
  relativePath?: string,
): Promise<WorkflowGitStatus> {
  const empty: WorkflowGitStatus = {
    sha: null,
    branch: null,
    detached: false,
    dirty: false,
    merging: false,
    rebasing: false,
  };
  if (!repoRoot || !existsSync(repoRoot)) return empty;
  try {
    const toplevel = existingRealpath(
      (await git(repoRoot, ["rev-parse", "--show-toplevel"])).stdout.trim(),
    );
    const sha = (await git(toplevel, ["rev-parse", "HEAD"])).stdout.trim();
    const branch = (await git(toplevel, ["rev-parse", "--abbrev-ref", "HEAD"]))
      .stdout
      .trim();
    const merging = await repoIsMerging(toplevel);
    const rebasing = await repoIsRebasing(toplevel);
    const statusPath = relativePath
      ? relative(
        toplevel,
        existingRealpath(resolve(toplevel, relativePath)),
      ).replaceAll("\\", "/")
      : "";
    if (statusPath.startsWith("..")) {
      return {
        sha: sha || null,
        branch: branch === "HEAD" ? null : branch || null,
        detached: branch === "HEAD" || !branch,
        dirty: false,
        merging,
        rebasing,
      };
    }
    const porcelainArgs = statusPath
      ? ["status", "--porcelain", "--", statusPath]
      : ["status", "--porcelain"];
    const porcelain = (await git(toplevel, porcelainArgs)).stdout.trim();
    return {
      sha: sha || null,
      branch: branch === "HEAD" ? null : branch || null,
      detached: branch === "HEAD" || !branch,
      dirty: porcelain.length > 0,
      merging,
      rebasing,
    };
  } catch {
    return empty;
  }
}

export async function preflightGitRepo(input: {
  repoRoot: string;
  allowedRoots: string[];
  requireNamedBranch?: boolean;
}): Promise<
  | { ok: true; toplevel: string; branch: string; sha: string }
  | { ok: false; code: WorkflowGitCommitCode; detail: string }
> {
  let toplevel: string;
  try {
    const parsed = (await git(input.repoRoot, ["rev-parse", "--show-toplevel"]))
      .stdout
      .trim();
    if (!parsed) {
      return { ok: false, code: "not-a-repo", detail: "not a git repository" };
    }
    toplevel = existingRealpath(parsed);
  } catch (err) {
    return { ok: false, code: "not-a-repo", detail: formatError(err) };
  }

  if (!isPathInsideAllowed(toplevel, input.allowedRoots)) {
    return {
      ok: false,
      code: "path-outside-repo",
      detail: `repo ${toplevel} is outside allowed roots`,
    };
  }

  const branch = (await git(toplevel, ["rev-parse", "--abbrev-ref", "HEAD"]))
    .stdout
    .trim();
  if (!branch || branch === "HEAD") {
    return { ok: false, code: "detached-head", detail: "HEAD is detached" };
  }
  if (input.requireNamedBranch) {
    const verify = await git(
      toplevel,
      ["show-ref", "--verify", `refs/heads/${branch}`],
      { allowFail: true },
    );
    if (verify.code !== 0) {
      return {
        ok: false,
        code: "detached-head",
        detail: `branch ${branch} is not a named refs/heads ref`,
      };
    }
  }

  const porcelain = (await git(toplevel, ["status", "--porcelain"])).stdout;
  const conflict = porcelain.split("\n").find((line) =>
    line.length >= 2 && CONFLICT_CODES.has(line.slice(0, 2))
  );
  if (conflict) {
    return {
      ok: false,
      code: "unresolved-conflicts",
      detail: `unresolved conflict: ${conflict.slice(3).trim() || conflict}`,
    };
  }

  if (await repoIsMerging(toplevel)) {
    return { ok: false, code: "merging", detail: "repository is merging" };
  }
  if (await repoIsRebasing(toplevel)) {
    return { ok: false, code: "rebasing", detail: "repository is rebasing" };
  }

  const sha = (await git(toplevel, ["rev-parse", "HEAD"])).stdout.trim();
  return { ok: true, toplevel, branch, sha };
}

export async function commitWorkflowFile(
  input: WorkflowGitCommitInput,
): Promise<WorkflowGitCommitResult> {
  const relativePath = normalizeRepoRelativePath(input.relativePath);
  if (!relativePath) {
    return {
      ok: false,
      code: "path-outside-repo",
      detail: `path escapes repo: ${input.relativePath}`,
    };
  }

  const preflight = await preflightGitRepo({
    repoRoot: input.repoRoot,
    allowedRoots: input.allowedRoots,
    requireNamedBranch: input.requireNamedBranch,
  });
  if (!preflight.ok) return preflight;

  const abs = resolve(preflight.toplevel, relativePath);
  if (!isPathInsideAllowed(abs, [preflight.toplevel])) {
    return {
      ok: false,
      code: "path-outside-repo",
      detail: `path escapes repo: ${input.relativePath}`,
    };
  }

  try {
    validateWorkflowMarkdown({
      markdown: input.markdown,
      path: input.sourceRoot
        ? workflowSourcePath(
          input.sourceRoot,
          filenameStem(relativePath),
        )
        : relativePath,
      sourceRoot: input.sourceRoot ?? "public",
      repos: input.repos ?? [],
      builtInCommands: input.builtInCommands,
    });
  } catch (err) {
    return { ok: false, code: "git-failed", detail: formatError(err) };
  }

  const existedAtHead = await pathExistsAtHead(preflight.toplevel, relativePath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, input.markdown);

  const add = await git(preflight.toplevel, ["add", "--", relativePath], {
    allowFail: true,
  });
  if (add.code !== 0) {
    await restoreWorkflowPath(preflight.toplevel, relativePath, existedAtHead);
    return {
      ok: false,
      code: "git-failed",
      detail: add.stderr.trim() || "git add failed",
    };
  }

  const commit = await git(preflight.toplevel, [
    "-c",
    `user.name=${DASHBOARD_GIT_NAME}`,
    "-c",
    `user.email=${DASHBOARD_GIT_EMAIL}`,
    "commit",
    "-m",
    input.message,
    "--",
    relativePath,
  ], { allowFail: true });
  if (commit.code !== 0) {
    await restoreWorkflowPath(preflight.toplevel, relativePath, existedAtHead);
    const detail = (commit.stderr || commit.stdout).trim() || "git commit failed";
    if (/nothing to commit/i.test(detail)) {
      return { ok: false, code: "nothing-to-commit", detail };
    }
    return { ok: false, code: "git-failed", detail };
  }

  const sha = (await git(preflight.toplevel, ["rev-parse", "HEAD"])).stdout.trim();
  const stagedOnly = await commitPaths(preflight.toplevel, sha);
  return { ok: true, sha, branch: preflight.branch, stagedOnly };
}

export async function commitParentPointer(input: {
  parentRoot: string;
  allowedRoots: string[];
  submodulePath?: string;
  message: string;
}): Promise<WorkflowGitCommitResult> {
  const submodulePath = input.submodulePath ?? "agents-org";
  const preflight = await preflightGitRepo({
    repoRoot: input.parentRoot,
    allowedRoots: input.allowedRoots,
  });
  if (!preflight.ok) return preflight;

  const add = await git(preflight.toplevel, ["add", "--", submodulePath], {
    allowFail: true,
  });
  if (add.code !== 0) {
    await git(preflight.toplevel, ["reset", "--", submodulePath], { allowFail: true });
    return {
      ok: false,
      code: "git-failed",
      detail: add.stderr.trim() || "git add agents-org failed",
    };
  }

  const commit = await git(preflight.toplevel, [
    "-c",
    `user.name=${DASHBOARD_GIT_NAME}`,
    "-c",
    `user.email=${DASHBOARD_GIT_EMAIL}`,
    "commit",
    "-m",
    input.message,
    "--",
    submodulePath,
  ], { allowFail: true });
  if (commit.code !== 0) {
    await git(preflight.toplevel, ["reset", "--", submodulePath], { allowFail: true });
    const detail = (commit.stderr || commit.stdout).trim() || "parent pointer commit failed";
    if (/nothing to commit/i.test(detail)) {
      return { ok: false, code: "nothing-to-commit", detail };
    }
    return { ok: false, code: "git-failed", detail };
  }

  const sha = (await git(preflight.toplevel, ["rev-parse", "HEAD"])).stdout.trim();
  const stagedOnly = await commitPaths(preflight.toplevel, sha);
  return { ok: true, sha, branch: preflight.branch, stagedOnly };
}

export async function writeDashboardWorkflow(
  input: DashboardWorkflowWriteInput,
): Promise<DashboardWorkflowWriteResult> {
  const sourcePath = workflowSourcePath(input.sourceRoot, input.name);
  try {
    validateWorkflowMarkdown({
      markdown: input.markdown,
      path: sourcePath,
      sourceRoot: input.sourceRoot,
      repos: input.repos,
      builtInCommands: input.builtInCommands,
    });
  } catch (err) {
    return { ok: false, code: "git-failed", detail: formatError(err) };
  }

  const allowedRoots = allowedGitRoots(input.projectRoot);
  const juniorRoot = existingRealpath(input.projectRoot);

  if (input.sourceRoot === "overlay") {
    const overlayDir = join(input.projectRoot, "agents-org");
    if (!overlayWorkflowsRootExists(input.projectRoot) && !existsSync(overlayDir)) {
      return {
        ok: false,
        code: "overlay-root-missing",
        detail: "overlay root missing",
      };
    }
    if (!existsSync(overlayDir)) {
      return { ok: false, code: "overlay-root-missing", detail: "overlay root missing" };
    }

    const overlayRoot = existingRealpath(overlayDir);
    const overlayPreflight = await preflightGitRepo({
      repoRoot: overlayRoot,
      allowedRoots,
      requireNamedBranch: true,
    });
    if (!overlayPreflight.ok) return overlayPreflight;
    if (existingRealpath(overlayPreflight.toplevel) !== overlayRoot) {
      return {
        ok: false,
        code: "not-a-repo",
        detail: "overlay is not its own git repository",
      };
    }

    const parentPreflight = await preflightGitRepo({
      repoRoot: juniorRoot,
      allowedRoots,
    });
    if (!parentPreflight.ok) return parentPreflight;

    const committed = await commitWorkflowFile({
      repoRoot: overlayRoot,
      allowedRoots,
      relativePath: `${PUBLIC_WORKFLOW_ROOT}/${input.name}.workflow.md`,
      markdown: input.markdown,
      message: input.message,
      requireNamedBranch: true,
      repos: input.repos,
      builtInCommands: input.builtInCommands,
      sourceRoot: "overlay",
    });
    if (!committed.ok) return committed;

    const parentMessage = input.parentMessage ??
      parentPointerCommitMessage(
        input.name,
        committed.sha,
        input.actor ?? "dashboard-operator",
      );
    const pointer = await commitParentPointer({
      parentRoot: juniorRoot,
      allowedRoots,
      message: parentMessage,
    });
    const stat = await showStat(overlayRoot, committed.sha);
    if (!pointer.ok) {
      return {
        ok: true,
        name: input.name,
        sourcePath,
        sourceRoot: "overlay",
        versionHash: hashWorkflowContent(input.markdown),
        overlayCommitted: true,
        commit: {
          sha: committed.sha,
          branch: committed.branch,
          repo: "agents-org",
          stat,
        },
        parentPointerCommitted: false,
        parentPointer: { code: pointer.code, detail: pointer.detail },
      };
    }
    return {
      ok: true,
      name: input.name,
      sourcePath,
      sourceRoot: "overlay",
      versionHash: hashWorkflowContent(input.markdown),
      overlayCommitted: true,
      commit: {
        sha: committed.sha,
        branch: committed.branch,
        repo: "agents-org",
        stat,
      },
      parentPointerCommitted: true,
      parentPointer: {
        sha: pointer.sha,
        branch: pointer.branch,
        stat: await showStat(juniorRoot, pointer.sha),
      },
    };
  }

  const committed = await commitWorkflowFile({
    repoRoot: juniorRoot,
    allowedRoots,
    relativePath: `${PUBLIC_WORKFLOW_ROOT}/${input.name}.workflow.md`,
    markdown: input.markdown,
    message: input.message,
    repos: input.repos,
    builtInCommands: input.builtInCommands,
    sourceRoot: "public",
  });
  if (!committed.ok) return committed;
  return {
    ok: true,
    name: input.name,
    sourcePath,
    sourceRoot: "public",
    versionHash: hashWorkflowContent(input.markdown),
    overlayCommitted: false,
    commit: {
      sha: committed.sha,
      branch: committed.branch,
      repo: "junior",
      stat: await showStat(juniorRoot, committed.sha),
    },
  };
}

export function defaultWorkflowCommitMessage(input: {
  kind: "create" | "update";
  name: string;
  sourceRoot: WorkflowSourceRoot;
  sourcePath: string;
  actor: string;
  commitMessage?: string;
}): string {
  const subject = input.commitMessage?.trim() ||
    `workflow(${input.name}): ${input.kind} from dashboard`;
  return [
    subject,
    "",
    `Source: ${input.sourceRoot} ${input.sourcePath}`,
    `Actor: ${input.actor}`,
  ].join("\n");
}

export function parentPointerCommitMessage(
  name: string,
  overlaySha: string,
  actor: string,
): string {
  return [
    `chore(agents-org): bump submodule after dashboard workflow(${name})`,
    "",
    `Overlay: ${overlaySha}`,
    `Actor: ${actor}`,
  ].join("\n");
}

export function isProtectedBranch(branch: string | null | undefined): boolean {
  return branch === "main" || branch === "master";
}

function normalizeRepoRelativePath(relativePath: string): string | null {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized) return null;
  const parts = normalized.split("/");
  if (parts.some((part) => part === ".." || part === "." || part === "")) return null;
  return parts.join("/");
}

function isPathInsideAllowed(absPath: string, allowedRoots: string[]): boolean {
  const resolved = existingRealpath(absPath);
  return allowedRoots.some((root) => {
    const allowed = existingRealpath(root);
    return resolved === allowed || resolved.startsWith(allowed + sep);
  });
}

function resolveGitPath(cwd: string, gitPath: string): string {
  return isAbsolute(gitPath) ? gitPath : resolve(cwd, gitPath);
}

async function repoIsMerging(cwd: string): Promise<boolean> {
  const mergeHead = (await git(cwd, ["rev-parse", "--git-path", "MERGE_HEAD"]))
    .stdout
    .trim();
  return Boolean(mergeHead) && existsSync(resolveGitPath(cwd, mergeHead));
}

async function repoIsRebasing(cwd: string): Promise<boolean> {
  const rebaseMerge = (await git(cwd, ["rev-parse", "--git-path", "rebase-merge"]))
    .stdout
    .trim();
  const rebaseApply = (await git(cwd, ["rev-parse", "--git-path", "rebase-apply"]))
    .stdout
    .trim();
  return (Boolean(rebaseMerge) && existsSync(resolveGitPath(cwd, rebaseMerge))) ||
    (Boolean(rebaseApply) && existsSync(resolveGitPath(cwd, rebaseApply)));
}

async function pathExistsAtHead(cwd: string, relativePath: string): Promise<boolean> {
  const result = await git(cwd, ["cat-file", "-e", `HEAD:${relativePath}`], {
    allowFail: true,
  });
  return result.code === 0;
}

// Restore from HEAD, not the index: a failed commit leaves the new bytes staged.
async function restoreWorkflowPath(
  cwd: string,
  relativePath: string,
  existedAtHead: boolean,
): Promise<void> {
  if (existedAtHead) {
    await git(cwd, [
      "restore",
      "--source=HEAD",
      "--staged",
      "--worktree",
      "--",
      relativePath,
    ], { allowFail: true });
    return;
  }
  await git(cwd, ["reset", "--", relativePath], { allowFail: true });
  const abs = join(cwd, relativePath);
  if (existsSync(abs)) unlinkSync(abs);
}

async function commitPaths(cwd: string, sha: string): Promise<string[]> {
  const show = await git(cwd, ["diff-tree", "--no-commit-id", "--name-only", "-r", sha], {
    allowFail: true,
  });
  return show.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function showStat(cwd: string, sha: string): Promise<string> {
  const show = await git(cwd, ["show", "--stat", "--format=", sha], { allowFail: true });
  return show.stdout.trim();
}

function filenameStem(relativePath: string): string {
  const base = relativePath.split("/").pop() ?? relativePath;
  return base.endsWith(".workflow.md")
    ? base.slice(0, -".workflow.md".length)
    : base;
}

function existingRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function git(
  cwd: string,
  args: string[],
  options: { allowFail?: boolean } = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0 && !options.allowFail) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr.trim() || stdout.trim()}`);
  }
  return { stdout, stderr, code };
}


