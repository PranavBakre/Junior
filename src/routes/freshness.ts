import { stat } from "node:fs/promises";
import type { StepStatus } from "./types.ts";

/**
 * Git state for route save and verify — and the rule that they must agree.
 *
 * Both operations resolve against ONE canonical ref, `origin/<default-branch>`,
 * read out of the object store with `git show <ref>:<path>` / `git grep <ref>`
 * rather than from the working tree. `route_save` fires at the end of a turn,
 * which usually means an unmerged feature worktree; if save stamped the local
 * HEAD and verify read the default worktree, the very first fetch would report
 * anchors `gone` or auto-repair them against whichever tree it happened to
 * read. Reading a ref removes the working copy from the picture entirely, so a
 * dirty checkout, a feature branch, or a half-finished rebase cannot influence
 * verification.
 */
export interface GitRefContext {
  repoPath: string;
  /** The canonical ref, e.g. `origin/main`. */
  ref: string;
  /** The commit that ref currently points at. */
  sha: string;
}

/** Number of consecutive majority-broken, unrepaired fetches before archival. */
export const ROUTE_ARCHIVE_BROKEN_FETCHES = 3;

/** Refs tried, in order, when the caller gives no hint. */
const FALLBACK_BRANCHES = ["main", "master"];

/** Marks a commit header in `git log --name-only` output. Never a valid path. */
const COMMIT_SENTINEL = "@@junior-route-commit@@";

/**
 * Resolve the canonical ref for a repo, or null when the repo is not on this
 * box / the ref cannot be resolved. Null is not an error — it is the signal
 * that every step must report `unknown` rather than `ok`.
 *
 * `defaultBase` is the repo's configured base (`RepoConfig.defaultBase`), which
 * may be written as `main` or as `origin/main`; both normalize to the
 * remote-tracking ref, because `git fetch` advances that and does NOT advance a
 * checked-out local branch.
 */
export async function resolveCanonicalRef(
  repoPath: string | null,
  defaultBase?: string,
): Promise<GitRefContext | null> {
  if (!repoPath) return null;
  try {
    const info = await stat(repoPath);
    if (!info.isDirectory()) return null;
  } catch {
    return null;
  }
  const probe = await git(["rev-parse", "--git-dir"], repoPath);
  if (!probe.ok) return null;

  const candidates: string[] = [];
  if (defaultBase) candidates.push(remoteTrackingRef(defaultBase));
  const head = await git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], repoPath);
  if (head.ok) {
    const branch = head.stdout.trim().replace(/^refs\/remotes\//, "");
    if (branch) candidates.push(branch);
  }
  for (const branch of FALLBACK_BRANCHES) candidates.push(`origin/${branch}`);

  for (const ref of dedupe(candidates)) {
    const resolved = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repoPath);
    const sha = resolved.stdout.trim();
    if (resolved.ok && sha) return { repoPath, ref, sha };
  }
  return null;
}

/** `main` / `origin/main` / `refs/heads/main` → the remote-tracking ref. */
function remoteTrackingRef(base: string): string {
  const trimmed = base.trim();
  if (trimmed.startsWith("refs/")) return trimmed;
  if (trimmed.includes("/")) return trimmed;
  return `origin/${trimmed}`;
}

/** File contents at the canonical ref, or null when the path is not on it. */
export async function gitShowFile(
  ctx: GitRefContext,
  path: string,
): Promise<string | null> {
  const result = await git(["show", `${ctx.ref}:${path}`], ctx.repoPath);
  return result.ok ? result.stdout : null;
}

/** Does `path` exist at the canonical ref? (Tier 0.) */
export async function gitFileExists(ctx: GitRefContext, path: string): Promise<boolean> {
  const result = await git(["cat-file", "-e", `${ctx.ref}:${path}`], ctx.repoPath);
  return result.ok;
}

export interface GitGrepHit {
  path: string;
  line: number;
  text: string;
}

/**
 * Repo-wide extended-regex search AT THE REF (tier 2). `git grep <ref>` rather
 * than a working-tree scanner, because the whole point is that the working copy
 * is not the tree being verified — and because a ref lives in the object store,
 * which only git can read.
 */
export async function gitGrep(
  ctx: GitRefContext,
  pattern: string,
): Promise<GitGrepHit[]> {
  const result = await git(
    // `-e` so a pattern that happens to start with `-` is never read as a flag.
    ["grep", "--no-color", "-n", "-I", "-E", "-e", pattern, ctx.ref],
    ctx.repoPath,
  );
  // Exit 1 is "no match", which is an answer, not a failure.
  if (!result.ok && result.stdout.trim() === "") return [];
  // Output is `<ref>:<path>:<line>:<text>`. A path containing a colon would be
  // truncated here; that degrades to a miss (the anchor will not re-resolve in
  // the truncated path), never to a wrong answer.
  const prefix = `${ctx.ref}:`;
  const hits: GitGrepHit[] = [];
  for (const raw of result.stdout.split("\n")) {
    if (!raw.startsWith(prefix)) continue;
    const rest = raw.slice(prefix.length);
    const pathEnd = rest.indexOf(":");
    if (pathEnd < 0) continue;
    const lineEnd = rest.indexOf(":", pathEnd + 1);
    if (lineEnd < 0) continue;
    const line = Number.parseInt(rest.slice(pathEnd + 1, lineEnd), 10);
    if (!Number.isFinite(line)) continue;
    hits.push({
      path: rest.slice(0, pathEnd),
      line,
      text: rest.slice(lineEnd + 1),
    });
  }
  return hits;
}

export interface RouteDrift {
  /** Commits touching the route's own paths since `verifiedSha`; null = unknown. */
  commits: number | null;
  /** Which of those paths were actually touched. Empty when `commits` is 0 or null. */
  changedPaths: Set<string>;
}

/**
 * Freshness is scoped to the route's OWN paths, never wall-clock. A route
 * written a year ago to a module nobody has touched is perfectly good; one
 * written last week to a file refactored twice since is garbage. Age is not the
 * signal; change is.
 *
 * One `git log` yields both halves: the commit count (route-level drift) and
 * the set of paths those commits touched (so an untouched step stays at tier 0
 * even when a sibling step's file moved under it).
 */
export async function routeDrift(
  ctx: GitRefContext,
  verifiedSha: string,
  paths: string[],
): Promise<RouteDrift> {
  const scoped = dedupe(paths.filter(Boolean));
  // A route of pure tooling notes has no paths, so nothing can have staled it.
  if (scoped.length === 0) return { commits: 0, changedPaths: new Set() };
  if (!verifiedSha) return { commits: null, changedPaths: new Set() };
  const result = await git(
    [
      "log",
      "--name-only",
      `--pretty=format:${COMMIT_SENTINEL}%H`,
      `${verifiedSha}..${ctx.ref}`,
      "--",
      ...scoped,
    ],
    ctx.repoPath,
  );
  // An unresolvable verified_sha (a squashed or never-pushed commit) is unknown
  // drift, not zero drift — reporting `untouched` there would be a lie.
  if (!result.ok) return { commits: null, changedPaths: new Set() };

  let commits = 0;
  const changedPaths = new Set<string>();
  for (const raw of result.stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    // The sentinel discriminates commit headers from the file names that follow
    // them; a bare `%H` would be ambiguous with an all-hex path.
    if (line.startsWith(COMMIT_SENTINEL)) {
      commits += 1;
      continue;
    }
    changedPaths.add(line);
  }
  return { commits, changedPaths };
}

/** Human-readable drift for the fetch response. */
export function describeDrift(drift: RouteDrift): string {
  if (drift.commits === null) return "unknown";
  if (drift.commits === 0) return "untouched";
  return `${drift.commits} commit${drift.commits === 1 ? "" : "s"}`;
}

export interface DecayVerdict {
  /** New consecutive-broken-fetch streak. */
  brokenFetches: number;
  /** Archive (`active = 0`) — never delete, matching the claim decay contract. */
  archive: boolean;
}

/**
 * A route flips `active = 0` when a majority of its anchored steps are
 * `gone`/`edge-broken` AND no repair has landed across N fetches. That is the
 * graceful end: it fades because it stopped being both useful and true, not
 * because it got old. `unknown` steps (repo absent, ref unresolvable) never
 * count as broken — an unreadable repo must not archive a good route.
 */
export function evaluateDecay(
  statuses: StepStatus[],
  previousBrokenFetches: number,
  repaired: boolean,
): DecayVerdict {
  const anchored = statuses.filter((status) => status !== "note");
  const broken = anchored.filter(
    (status) => status === "gone" || status === "edge-broken",
  ).length;
  const majorityBroken = anchored.length > 0 && broken * 2 > anchored.length;
  if (repaired || !majorityBroken) return { brokenFetches: 0, archive: false };
  const brokenFetches = previousBrokenFetches + 1;
  return { brokenFetches, archive: brokenFetches >= ROUTE_ARCHIVE_BROKEN_FETCHES };
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Run git and capture both streams. Never assumes a warm process or a daemon:
 * every call is a fresh short-lived subprocess. `--no-pager` and
 * `core.quotepath=false` keep the output machine-readable (and non-ASCII paths
 * unescaped).
 */
async function git(args: string[], cwd: string): Promise<GitResult> {
  try {
    const proc = Bun.spawn(["git", "--no-pager", "-c", "core.quotepath=false", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    // Drain both pipes BEFORE awaiting exit — a repo-wide grep can outrun the
    // pipe buffer, and a blocked writer never exits.
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    return { ok: code === 0, stdout, stderr };
  } catch (error) {
    // The checkout can vanish mid-verification (a worktree prune, a removed
    // mount). That is an unresolvable ref, not a crashed fetch.
    return { ok: false, stdout: "", stderr: String(error) };
  }
}

function dedupe<T>(values: T[]): T[] {
  return [...new Set(values)];
}
