import { createHash } from "node:crypto";
import {
  gitFileExists,
  gitGrep,
  gitShowFile,
  type GitRefContext,
} from "./freshness.ts";
import type {
  StepRepair,
  StepStatus,
  TaskRouteStepRecord,
  VerificationTier,
  VerifiedBy,
} from "./types.ts";

/**
 * Anchors: expensive at write, free at read.
 *
 * There is no warm language server to lean on — an LSP owned by the operator's
 * editor is unreachable from Junior's process, and dev servers are opt-in and
 * unset for most pipeline runs, so any tier conditioned on "a server is warm"
 * would silently never activate. A ctags/gtags index is a net negative for the
 * same reason it is unnecessary: resolving one symbol repo-wide is ~15ms of
 * grep, and an index adds a second source of staleness to accelerate a lookup
 * that was already free.
 *
 * What IS worth stealing from ctags: it anchors on a search *pattern*, not a
 * line number. `decl_pattern` is that idea. Every pattern here is written in
 * the intersection of POSIX ERE and JavaScript RegExp, because the same string
 * is handed to `git grep -E` for the repo-wide tier and compiled in-process for
 * the single-file tier.
 */

/** Longest block a fingerprint will span before it is truncated. */
const MAX_BLOCK_LINES = 400;
/** Longest brace-less "paragraph" treated as an anchor's block. */
const MAX_PARAGRAPH_LINES = 40;
/** How far past the declaration line to look for the opening brace. */
const SIGNATURE_LOOKAHEAD = 3;

const BOUND_BEFORE = "(^|[^A-Za-z0-9_$])";
const BOUND_AFTER = "([^A-Za-z0-9_$]|$)";
// A literal space and tab: \s and \t are not portable across POSIX ERE.
const WS = "[ \t]";

export interface ResolvedAnchor {
  path: string;
  /** 1-based line of the declaration. */
  line: number;
  declPattern: string;
  sigHash: string;
  blockHash: string;
}

export interface StepVerification {
  ord: number;
  status: StepStatus;
  /** Which tier answered — the calibration signal the reading agent needs. */
  tier: VerificationTier;
  verifiedBy: VerifiedBy;
  /** Set when tier 2 found the symbol somewhere other than the stored path. */
  resolvedPath?: string;
  /** Set when the anchor should be rewritten in place (moved, or activated). */
  repair?: StepRepair;
}

/**
 * Declaration-shaped patterns for a symbol, cheapest and most specific first.
 * `declarationsOnly` drops the bare-occurrence fallback: it matches import and
 * call sites too, which is acceptable when the anchor is a non-code marker but
 * would make a repo-wide search report a call site as the symbol's new home.
 */
export function declPatternCandidates(
  symbol: string,
  options: { declarationsOnly?: boolean } = {},
): string[] {
  const sym = escapeEre(symbol);
  const patterns = [
    // `export function foo`, `const foo`, `class Foo`, `type Foo`, `def foo`…
    `${BOUND_BEFORE}(function|class|interface|type|enum|const|let|var|struct|trait|def|fn)${WS}+${sym}${BOUND_AFTER}`,
    // A method or bare function definition at the start of a line.
    `^${WS}*(export${WS}+)?(default${WS}+)?(async${WS}+)?(static${WS}+)?(public|private|protected)?${WS}*${sym}${WS}*\\(`,
    // An object key, a CSS selector body, a YAML/TS property.
    `^${WS}*${sym}${WS}*[:=]`,
  ];
  if (options.declarationsOnly) return patterns;
  // Last-ditch for non-code anchors: section-marker comments, HTML ids.
  return [...patterns, `${BOUND_BEFORE}${sym}${BOUND_AFTER}`];
}

export interface ResolveInFileOptions {
  /** The stored anchor, tried before the generated candidates. */
  declPattern?: string | null;
  /**
   * Drop the bare-occurrence fallback. Verification MUST set this for anchors
   * that were recorded as declarations: after a symbol moves out of a file, the
   * import line it leaves behind still mentions it, and a loose match there
   * would report `drifted` in the old file instead of `moved` to the new one.
   */
  declarationsOnly?: boolean;
}

/**
 * Resolve a symbol inside one file at the canonical ref and fingerprint it.
 * The stored `declPattern` is tried first; the generated candidates are the
 * fallback, so a symbol that changed declaration form (`function x` → `const
 * x = () =>`) is still found in place rather than being reported gone.
 */
export async function resolveAnchorInFile(
  ctx: GitRefContext,
  path: string,
  symbol: string,
  options: ResolveInFileOptions = {},
): Promise<ResolvedAnchor | null> {
  const content = await gitShowFile(ctx, path);
  if (content === null) return null;
  const lines = content.split("\n");
  const candidates = declPatternCandidates(symbol, {
    declarationsOnly: options.declarationsOnly === true,
  });
  const patterns = options.declPattern
    ? [options.declPattern, ...candidates]
    : candidates;
  for (const pattern of patterns) {
    const regex = compile(pattern);
    if (!regex) continue;
    for (let i = 0; i < lines.length; i += 1) {
      if (!regex.test(lines[i])) continue;
      return fingerprintAt(lines, i, pattern, path);
    }
  }
  return null;
}

/**
 * Tier 2: search the whole repo AT THE REF for the declaration. Returns the
 * first hit outside `excludePath` (git grep already orders by path, so the
 * answer is deterministic).
 */
export async function resolveAnchorRepoWide(
  ctx: GitRefContext,
  symbol: string,
  declPattern: string | null,
  excludePath?: string,
): Promise<ResolvedAnchor | null> {
  const safe = declPatternCandidates(symbol, { declarationsOnly: true });
  // A stored bare-occurrence pattern is not safe to run repo-wide — it would
  // match every import of the symbol.
  const patterns = declPattern && safe.includes(declPattern)
    ? [declPattern, ...safe.filter((p) => p !== declPattern)]
    : safe;
  for (const pattern of patterns) {
    const hits = await gitGrep(ctx, pattern);
    for (const hit of hits) {
      if (excludePath && hit.path === excludePath) continue;
      const resolved = await resolveAnchorInFile(ctx, hit.path, symbol, {
        declPattern: pattern,
        declarationsOnly: true,
      });
      if (resolved) return resolved;
    }
  }
  return null;
}

/**
 * Verify one step against the canonical ref, cheapest tier first. Every tier is
 * grep- or git-cost, so the ladder always runs to an answer; what varies is
 * which tier produced it, and that is reported back.
 *
 *  0  path exists, and nothing in the route's own paths changed → `untouched`
 *  1  symbol present in path, fingerprints compared         → `ok` / `drifted`
 *  2  decl_pattern resolved repo-wide when tier 1 failed    → `moved` / `gone`
 *  3  expects_ref still present in the named file           → `edge-broken`
 */
export async function verifyStep(
  ctx: GitRefContext,
  step: TaskRouteStepRecord,
  options: { untouched: boolean },
): Promise<StepVerification> {
  // Pure tooling note — a dead end worth skipping has nothing on disk to check.
  if (!step.path) {
    return { ord: step.ord, status: "note", tier: null, verifiedBy: "none" };
  }

  // An anchor captured from an unmerged branch never resolved on the canonical
  // ref, so it cannot be short-circuited by tier 0. Try to activate it: if the
  // work has since merged, this fetch fingerprints it for free.
  //
  // Declaration candidates FIRST. At save the agent asserted the file, so a
  // loose bare-occurrence match there is its word; at activation the pattern is
  // manufactured, and a loose match would happily fingerprint an import line
  // and persist that pattern as the repair. The loose form stays as a last
  // resort, because section markers and HTML ids have no declaration shape.
  if (step.symbol && !step.declPattern) {
    const symbol = step.symbol;
    const declared = await resolveAnchorInFile(ctx, step.path, symbol, {
      declarationsOnly: true,
    });
    if (declared) {
      return withEdgeCheck(ctx, step, {
        ord: step.ord,
        status: "ok",
        tier: 1,
        verifiedBy: "fingerprint",
        repair: toRepair(step.ord, declared),
      });
    }
    // The file may have been renamed between the save and the merge. Falling
    // through to tier 2 activates the step instead of leaving it pending
    // forever in a path that no longer exists.
    //
    // RESIDUAL HAZARD, accepted deliberately: this inverts the normal ladder
    // for a marker-style anchor. A section marker recorded on an unmerged
    // branch, whose identifier is ALSO declared somewhere else in the repo,
    // repairs to that other file and rewrites `path` away from the file the
    // agent named. The alternative ordering is worse: putting the loose in-file
    // match first lets activation fingerprint the import line a moved symbol
    // left behind and report `ok` / `fingerprint` at the stale path — wrong,
    // and invisible. This way the mistake surfaces as `moved` with a
    // `resolved_path` the reader can see and the agent can overwrite.
    const moved = await resolveAnchorRepoWide(ctx, symbol, null, step.path);
    if (moved) {
      return withEdgeCheck(ctx, step, {
        ord: step.ord,
        status: "moved",
        tier: 2,
        verifiedBy: "decl-pattern",
        resolvedPath: moved.path,
        repair: toRepair(step.ord, moved),
      });
    }
    const loose = await resolveAnchorInFile(ctx, step.path, symbol);
    if (!loose) {
      return { ord: step.ord, status: "pending", tier: null, verifiedBy: "none" };
    }
    return withEdgeCheck(ctx, step, {
      ord: step.ord,
      status: "ok",
      tier: 1,
      verifiedBy: "fingerprint",
      repair: toRepair(step.ord, loose),
    });
  }

  const exists = await gitFileExists(ctx, step.path);

  // Tier 0 — nothing has touched this path since it was verified. Fresh
  // regardless of age, and nothing deeper can disagree.
  if (exists && options.untouched) {
    return {
      ord: step.ord,
      status: "untouched",
      tier: 0,
      verifiedBy: "git-untouched",
    };
  }

  // A file-level pointer with no symbol: path existence is all there is, and
  // `path-only` is exactly the weaker evidence the caller must be told about.
  if (!step.symbol) {
    if (!exists) {
      return { ord: step.ord, status: "gone", tier: 0, verifiedBy: "path-only" };
    }
    return withEdgeCheck(ctx, step, {
      ord: step.ord,
      status: "ok",
      tier: 0,
      verifiedBy: "path-only",
    });
  }
  const symbol = step.symbol;

  // Tier 1 — the symbol is still in the file it was recorded in.
  if (exists) {
    // A marker-style anchor was recorded with the loose pattern in the first
    // place, so loose fallbacks stay legal for it; a declaration anchor gets
    // declaration fallbacks only.
    const declarationsOnly =
      step.declPattern === null ||
      declPatternCandidates(symbol, { declarationsOnly: true }).includes(step.declPattern);
    const found = await resolveAnchorInFile(ctx, step.path, symbol, {
      declPattern: step.declPattern,
      declarationsOnly,
    });
    if (found) {
      const intact =
        found.sigHash === step.sigHash && found.blockHash === step.blockHash;
      return withEdgeCheck(ctx, step, {
        ord: step.ord,
        status: intact ? "ok" : "drifted",
        tier: 1,
        verifiedBy: "fingerprint",
      });
    }
  }

  // Tier 2 — an ordinary refactor moved it. Resolving here is what makes routes
  // survive refactors for free; a route should only die when the *concept* goes.
  const moved = await resolveAnchorRepoWide(ctx, symbol, step.declPattern, step.path);
  if (!moved) {
    return { ord: step.ord, status: "gone", tier: 2, verifiedBy: "decl-pattern" };
  }
  return withEdgeCheck(ctx, step, {
    ord: step.ord,
    status: "moved",
    tier: 2,
    verifiedBy: "decl-pattern",
    resolvedPath: moved.path,
    repair: toRepair(step.ord, moved),
  });
}

/**
 * Tier 3 — a route names BOTH ends of every edge it records, so "does this file
 * still reference X" is a single-file grep, not a repo-wide question. That is
 * why no global reference index is needed. Only ever downgrades: a broken edge
 * overrides an otherwise-fine fingerprint, because the step's premise is gone.
 */
async function withEdgeCheck(
  ctx: GitRefContext,
  step: TaskRouteStepRecord,
  verification: StepVerification,
): Promise<StepVerification> {
  if (!step.expectsRef) return verification;
  const path = verification.resolvedPath ?? step.path;
  if (!path) return verification;
  const content = await gitShowFile(ctx, path);
  if (content !== null && content.includes(step.expectsRef)) return verification;
  return {
    ...verification,
    status: "edge-broken",
    tier: 3,
    verifiedBy: "expects-ref",
  };
}

function toRepair(ord: number, anchor: ResolvedAnchor): StepRepair {
  return {
    ord,
    path: anchor.path,
    declPattern: anchor.declPattern,
    sigHash: anchor.sigHash,
    blockHash: anchor.blockHash,
  };
}

/** Fingerprint the declaration at `index`: its own line, and its block. */
function fingerprintAt(
  lines: string[],
  index: number,
  pattern: string,
  path: string,
): ResolvedAnchor {
  return {
    path,
    line: index + 1,
    declPattern: pattern,
    sigHash: hash(lines[index].trim().replace(/\s+/g, " ")),
    blockHash: hash(normalizeBlock(extractBlock(lines, index))),
  };
}

/**
 * The enclosing block for a declaration: brace-balanced when one opens within a
 * few lines (a multi-line signature is common), otherwise the contiguous
 * non-blank run beneath it — which is what a `const`, an import, or a section
 * marker actually has. Deliberately naive about braces inside strings and
 * comments: the hash only has to CHANGE when the code changes, and a brace
 * appearing inside a string literal is itself a change.
 */
function extractBlock(lines: string[], index: number): string[] {
  const openAt = findOpeningBrace(lines, index);
  if (openAt < 0) {
    let end = index;
    while (
      end + 1 < lines.length &&
      lines[end + 1].trim() !== "" &&
      end - index < MAX_PARAGRAPH_LINES
    ) {
      end += 1;
    }
    return lines.slice(index, end + 1);
  }
  let depth = 0;
  const limit = Math.min(lines.length, index + MAX_BLOCK_LINES);
  for (let i = index; i < limit; i += 1) {
    depth += braceDelta(lines[i]);
    if (i >= openAt && depth <= 0) return lines.slice(index, i + 1);
  }
  return lines.slice(index, limit);
}

function findOpeningBrace(lines: string[], index: number): number {
  const limit = Math.min(lines.length, index + SIGNATURE_LOOKAHEAD + 1);
  for (let i = index; i < limit; i += 1) {
    if (lines[i].includes("{")) return i;
  }
  return -1;
}

function braceDelta(line: string): number {
  let delta = 0;
  for (const char of line) {
    if (char === "{") delta += 1;
    else if (char === "}") delta -= 1;
  }
  return delta;
}

/** Reindentation and blank lines are not changes; content is. */
function normalizeBlock(lines: string[]): string {
  return lines
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("\n");
}

function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Escape ERE metacharacters — the escapes below are also valid in JS RegExp. */
function escapeEre(symbol: string): string {
  return symbol.replace(/[.[\]{}()*+?^$|\\]/g, "\\$&");
}

/** A stored pattern comes from the DB; a malformed one must not throw the fetch. */
function compile(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}
