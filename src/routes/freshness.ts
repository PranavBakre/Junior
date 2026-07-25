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
  /**
   * ISO-8601 committer date of `sha`, or null when it cannot be read.
   *
   * Reported all the way out to the caller, because nothing else in the system
   * guarantees the remote-tracking ref is current: if the box has not fetched
   * this repo in three weeks, every step still answers `untouched` /
   * `git-untouched` — maximum confidence about a tree nobody is working on. The
   * bounded fetch below usually prevents that; the date is what makes the
   * annotation honest when it does not.
   */
  committedAt: string | null;
  /**
   * What the pre-read `git fetch` did. `failed` and `throttled` both mean the
   * ref may be behind the remote, and the reader cannot infer that from a date
   * alone — the annotation IS the error signal, so it is stated.
   */
  fetchStatus: RefFetchStatus;
}

/**
 * `skipped` — no fetch was asked for, or the ref is not remote-tracking so a
 * fetch could not advance it anyway.
 */
export type RefFetchStatus = "ok" | "throttled" | "failed" | "skipped";

/** Number of consecutive majority-broken, unrepaired fetches before archival. */
export const ROUTE_ARCHIVE_BROKEN_FETCHES = 3;

/**
 * At most one `git fetch` per repo+ref in this window. The window is
 * process-local and in-memory: a restart forgets it and the next call fetches.
 */
export const REF_FETCH_MIN_INTERVAL_MS = 10 * 60_000;
/** A network hang must never hold a tool call open. See `git()`. */
export const REF_FETCH_TIMEOUT_MS = 5_000;

/** Refs tried, in order, when the caller gives no hint. */
const FALLBACK_BRANCHES = ["main", "master"];

/** Marks a commit header in `git log --name-only` output. Never a valid path. */
const COMMIT_SENTINEL = "@@junior-route-commit@@";

/** `${repoPath}::${ref}` → when it was last fetched, for the throttle. */
const lastFetchAt = new Map<string, number>();

/** Tests only: forget the fetch throttle so a case can force a second fetch. */
export function resetRefFetchThrottle(): void {
  lastFetchAt.clear();
}

export interface ResolveRefOptions {
  /**
   * Advance the remote-tracking ref before reading it (throttled + bounded).
   * The design rests on `git fetch` advancing `origin/<branch>`, and nothing
   * else in this feature fetches — `WorktreeManager.createWorktree` only fires
   * when a thread creates a worktree, and never for the cwd fallback.
   */
  fetch?: boolean;
  now?: number;
}

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
  options: ResolveRefOptions = {},
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
    if (!resolved.ok || !resolved.stdout.trim()) continue;
    let sha = resolved.stdout.trim();
    let fetchStatus: RefFetchStatus = "skipped";
    if (options.fetch) {
      const fetched = await maybeFetchRef(repoPath, ref, options.now ?? Date.now());
      fetchStatus = fetched.status;
      if (fetched.sha) sha = fetched.sha;
    }
    return { repoPath, ref, sha, committedAt: await commitDate(repoPath, sha), fetchStatus };
  }
  return null;
}

/**
 * Best-effort `git fetch origin <branch>`: at most once per repo+ref per
 * window, hard-bounded in time, and only ever touching remote-tracking refs
 * (never the working tree or a local branch). A failure is not an error — the
 * caller falls back to whatever the ref already pointed at, and the reported
 * `fetchStatus` + `committedAt` tell the reader exactly that.
 */
async function maybeFetchRef(
  repoPath: string,
  ref: string,
  now: number,
): Promise<{ status: RefFetchStatus; sha: string | null }> {
  // Only a remote-tracking ref advances on fetch; a local `refs/heads/...` base
  // would be untouched, so spending the network call on it is pointless.
  //
  // `remoteTrackingRef` passes a `refs/`-prefixed configured base through
  // unchanged, so `defaultBase: "refs/remotes/origin/main"` names a ref that IS
  // remote-tracking and WOULD advance. Testing the short spelling alone reported
  // that as `skipped` — the one status meaning "nothing was missed" — and
  // silently disabled fetching for that repo. `defaultBase` is operator JSON, so
  // both spellings have to be understood.
  const tracking = ref.startsWith("refs/remotes/")
    ? ref.slice("refs/remotes/".length)
    : ref;
  if (!tracking.startsWith("origin/")) return { status: "skipped", sha: null };
  const branch = tracking.slice("origin/".length);
  if (!branch) return { status: "skipped", sha: null };
  const key = `${repoPath}::${ref}`;
  if (now - (lastFetchAt.get(key) ?? 0) < REF_FETCH_MIN_INTERVAL_MS) {
    return { status: "throttled", sha: null };
  }
  // Stamp BEFORE the call: a repo whose remote is unreachable must not re-pay
  // the timeout on every single fetch.
  lastFetchAt.set(key, now);
  const fetched = await git(
    [
      // Make the transport bound ITSELF rather than depend on the peer: without
      // these, a killed git leaves a helper alive for as long as the far side
      // holds the connection open. The race in `git()` is still the guarantee;
      // this just stops the orphan outliving it.
      "-c",
      "http.lowSpeedLimit=1",
      "-c",
      "http.lowSpeedTime=5",
      // An explicit refspec rather than `fetch origin <branch>`: the plain form
      // only updates the remote-tracking ref opportunistically, through whatever
      // refspec the remote happens to be configured with.
      "fetch",
      "--quiet",
      "origin",
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ],
    repoPath,
    { timeoutMs: REF_FETCH_TIMEOUT_MS, env: await nonInteractiveEnv(repoPath) },
  );
  if (!fetched.ok) return { status: "failed", sha: null };
  const resolved = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], repoPath);
  const sha = resolved.stdout.trim();
  return { status: "ok", sha: resolved.ok && sha ? sha : null };
}

/**
 * A prompt is a hang with a nicer name. `git fetch` will ask for credentials on
 * a terminal and `ssh` reads `/dev/tty` directly — closing stdin does not save
 * you — so both are told up front to fail instead of asking.
 *
 * `credential.helper` is deliberately NOT cleared: the private repos this
 * fetches (GX over https) authenticate through the keychain helper, and
 * disabling it would turn every fetch into a silent `failed` and put the
 * staleness this fix exists to remove straight back. A helper that does hang is
 * covered by the hard bound in `git()`.
 */
async function nonInteractiveEnv(repoPath: string): Promise<Record<string, string>> {
  // Appended, not replaced: an operator's custom identity or jump host must
  // survive. `GIT_SSH_COMMAND` outranks `core.sshCommand` in git's precedence,
  // so setting the env var without seeding it from the config SILENTLY DROPS a
  // config-only ssh command — auth then fails, the fetch reports `failed`, and
  // the ref goes stale. That is the same silent-staleness this fetch exists to
  // remove, so the config is read when the env var is unset.
  let sshCommand = process.env.GIT_SSH_COMMAND?.trim();
  if (!sshCommand) {
    const configured = await git(["config", "--get", "core.sshCommand"], repoPath);
    const value = configured.stdout.trim();
    if (configured.ok && value) sshCommand = value;
  }
  return {
    GIT_TERMINAL_PROMPT: "0",
    // ConnectTimeout is the ssh half of the self-bounding above.
    GIT_SSH_COMMAND: `${sshCommand || "ssh"} -oBatchMode=yes -oConnectTimeout=5`,
  };
}

async function commitDate(repoPath: string, sha: string): Promise<string | null> {
  const result = await git(["show", "-s", "--format=%cI", sha], repoPath);
  const date = result.stdout.trim();
  return result.ok && date ? date : null;
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
export interface RouteDriftOptions {
  /**
   * Force the pre-2.31 command shape. Production always tries `true` first, so
   * without this the no-flag branch and the opaque-commit rule below — the code
   * that carries correctness on an old git — are unreachable in tests, and a
   * later tidy-up of the parser could silently restore the original blocker.
   */
  diffMerges?: boolean;
}

export async function routeDrift(
  ctx: GitRefContext,
  verifiedSha: string,
  paths: string[],
  options: RouteDriftOptions = {},
): Promise<RouteDrift> {
  const scoped = dedupe(paths.filter(Boolean));
  // A route of pure tooling notes has no paths, so nothing can have staled it.
  if (scoped.length === 0) return { commits: 0, changedPaths: new Set() };
  if (!verifiedSha) return { commits: null, changedPaths: new Set() };
  const args = (diffMerges: boolean) => [
    "log",
    "--name-only",
    // A merge commit has NO diff unless one is asked for, so `--name-only`
    // prints a bare header for it. This repo's workflow is always 3-way merges,
    // never squash, so a merge carrying a conflict resolution or a build fixup
    // is the norm; without this flag such a commit is counted in `commits` but
    // never lands in `changedPaths`, and tier 0 then answers `untouched` —
    // `git-untouched`, the strongest label in the system — for a path the merge
    // actually rewrote. First-parent is the right side: it is exactly "what
    // changed on the canonical branch when this landed".
    ...(diffMerges ? ["--diff-merges=first-parent"] : []),
    `--pretty=format:${COMMIT_SENTINEL}%H`,
    `${verifiedSha}..${ctx.ref}`,
    "--",
    ...scoped,
  ];
  const diffMerges = options.diffMerges !== false;
  let result = await git(args(diffMerges), ctx.repoPath);
  // `--diff-merges` landed in git 2.31. Rather than pin a version floor, retry
  // without it and let the opaque-commit rule below carry the correctness.
  if (!result.ok && diffMerges) result = await git(args(false), ctx.repoPath);
  // An unresolvable verified_sha (a squashed or never-pushed commit) is unknown
  // drift, not zero drift — reporting `untouched` there would be a lie.
  if (!result.ok) return { commits: null, changedPaths: new Set() };

  let commits = 0;
  let pathsInCommit = 0;
  /** A commit git listed but attributed no path to — see below. */
  let opaqueCommit = false;
  const changedPaths = new Set<string>();
  for (const raw of result.stdout.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    // The sentinel discriminates commit headers from the file names that follow
    // them; a bare `%H` would be ambiguous with an all-hex path.
    if (line.startsWith(COMMIT_SENTINEL)) {
      if (commits > 0 && pathsInCommit === 0) opaqueCommit = true;
      commits += 1;
      pathsInCommit = 0;
      continue;
    }
    pathsInCommit += 1;
    changedPaths.add(line);
  }
  if (commits > 0 && pathsInCommit === 0) opaqueCommit = true;
  // The pathspec already decided this commit is relevant, so a commit with no
  // named path is one whose diff git declined to compute (a merge on an old
  // git, or a shape `--diff-merges=first-parent` still shows without a
  // first-parent diff). Which of the scoped paths it touched is unknown, so
  // assume all of them: that costs a tier-1 fingerprint check per step and
  // yields `ok` when nothing really changed. The opposite error — a silent
  // `git-untouched` over a real edit — is self-concealing, because a clean
  // fetch bumps `verified_sha` past the commit and erases it from the record.
  if (opaqueCommit) for (const path of scoped) changedPaths.add(path);
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
async function git(
  args: string[],
  cwd: string,
  options: { timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<GitResult> {
  const command = ["git", "--no-pager", "-c", "core.quotepath=false", ...args];
  const spawnOptions = {
    cwd,
    ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
  };
  try {
    // Only the network-bound call passes a timeout; a local object-store read
    // cannot hang, and killing one would only mask a real failure.
    if (options.timeoutMs === undefined) {
      const proc = Bun.spawn(command, { ...spawnOptions, stdout: "pipe", stderr: "pipe" });
      // Drain both pipes BEFORE awaiting exit — a repo-wide grep can outrun the
      // pipe buffer, and a blocked writer never exits.
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      return { ok: (await proc.exited) === 0, stdout, stderr };
    }

    // A bounded call must NOT read its pipes, and must not wait on exit alone.
    //
    // `git fetch` over any helper transport spawns a SEPARATE process
    // (`git-remote-https`, or `ssh`) that inherits the piped stderr. SIGKILLing
    // git does not reach the helper, so the write end of that pipe stays open,
    // `new Response(proc.stderr).text()` never resolves, and the tool call
    // hangs indefinitely — measured at 30s+ on https and ssh, while only the
    // pipe-less `git://` respected the bound. Ignoring both streams removes the
    // pipe, and racing the timer against exit means even an unkillable child
    // cannot hold the caller. The bounded caller discards output anyway.
    const proc = Bun.spawn(command, { ...spawnOptions, stdout: "ignore", stderr: "ignore" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolveTimeout) => {
      timer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolveTimeout("timeout");
      }, options.timeoutMs);
    });
    try {
      const outcome = await Promise.race([proc.exited, timedOut]);
      if (outcome === "timeout") {
        return { ok: false, stdout: "", stderr: `timed out after ${options.timeoutMs}ms` };
      }
      return { ok: outcome === 0, stdout: "", stderr: "" };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    // The checkout can vanish mid-verification (a worktree prune, a removed
    // mount). That is an unresolvable ref, not a crashed fetch.
    return { ok: false, stdout: "", stderr: String(error) };
  }
}

function dedupe<T>(values: T[]): T[] {
  return [...new Set(values)];
}
