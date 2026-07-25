import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * TEST-ONLY: a real git repo with a real `origin` remote.
 *
 * Nothing in the runtime imports this. Task-route verification is defined
 * entirely in terms of `origin/<default-branch>` resolved out of the object
 * store, so a fake git layer would prove nothing — the behaviour under test IS
 * the git behaviour. Tests build a throwaway repo, push to a bare clone, and
 * let `origin/main` be a genuine remote-tracking ref.
 */
export interface FixtureRepo {
  /** The working checkout. */
  path: string;
  /** Write files (paths repo-relative), creating parent directories. */
  write(files: Record<string, string>): void;
  /** Delete files from the working tree. */
  remove(paths: string[]): void;
  /** Stage everything and commit on the current branch. Returns the sha. */
  commit(message: string): Promise<string>;
  /** Advance `origin/main` to the current HEAD, then fetch — i.e. "it merged". */
  publish(): Promise<void>;
  /** Switch branches, creating the branch when `create` is set. */
  checkout(branch: string, options?: { create?: boolean }): Promise<void>;
  /**
   * A real `--no-ff` merge commit, optionally carrying edits made DURING the
   * merge (a conflict resolution or a build fixup). Those edits exist only in
   * the merge commit, which is why `git log --name-only` says nothing about
   * them unless a diff against a parent is explicitly requested.
   */
  merge(branch: string, filesInMerge?: Record<string, string>): Promise<string>;
  /** Current `origin/main` commit. */
  originSha(): Promise<string>;
  /**
   * Rewind the LOCAL `origin/main` remote-tracking ref without touching the
   * bare remote — i.e. "this box has not fetched in a while".
   */
  rewindOriginRef(sha: string): Promise<void>;
  cleanup(): void;
}

export async function createFixtureRepo(prefix = "junior-routes-"): Promise<FixtureRepo> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const path = join(root, "repo");
  const bare = join(root, "origin.git");
  mkdirSync(path, { recursive: true });

  await run(["git", "init", "-q", "-b", "main", "."], path);
  await run(["git", "init", "-q", "--bare", "-b", "main", bare], root);
  await run(["git", "remote", "add", "origin", bare], path);

  const repo: FixtureRepo = {
    path,
    write(files) {
      for (const [relative, content] of Object.entries(files)) {
        const target = join(path, relative);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
      }
    },
    remove(paths) {
      for (const relative of paths) {
        rmSync(join(path, relative), { force: true });
      }
    },
    async commit(message) {
      await run(["git", "add", "-A"], path);
      await run(
        [
          "git",
          "-c",
          "user.email=fixture@junior.test",
          "-c",
          "user.name=fixture",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "-q",
          "-m",
          message,
        ],
        path,
      );
      return (await run(["git", "rev-parse", "HEAD"], path)).trim();
    },
    async publish() {
      await run(["git", "push", "-q", "origin", "HEAD:main"], path);
      await run(["git", "fetch", "-q", "origin", "--prune"], path);
    },
    async checkout(branch, options = {}) {
      const args = options.create
        ? ["git", "checkout", "-q", "-b", branch]
        : ["git", "checkout", "-q", branch];
      await run(args, path);
    },
    async merge(branch, filesInMerge) {
      await run(["git", "merge", "--no-ff", "--no-commit", branch], path, {
        // A conflicting merge exits non-zero and leaves the tree for us to fix,
        // which is exactly the case worth exercising.
        allowFailure: true,
      });
      if (filesInMerge) repo.write(filesInMerge);
      await run(["git", "add", "-A"], path);
      await run(
        [
          "git",
          "-c",
          "user.email=fixture@junior.test",
          "-c",
          "user.name=fixture",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "-q",
          "--no-edit",
          "-m",
          `merge ${branch}`,
        ],
        path,
      );
      return (await run(["git", "rev-parse", "HEAD"], path)).trim();
    },
    async originSha() {
      return (await run(["git", "rev-parse", "origin/main"], path)).trim();
    },
    async rewindOriginRef(sha) {
      await run(["git", "update-ref", "refs/remotes/origin/main", sha], path);
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
  return repo;
}

async function run(
  args: string[],
  cwd: string,
  options: { allowFailure?: boolean } = {},
): Promise<string> {
  const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  if (code !== 0 && !options.allowFailure) {
    throw new Error(`${args.join(" ")} failed: ${stderr.trim()}`);
  }
  return stdout;
}
