import { basename } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTool } from "../mcp/register-tool.ts";
import type { EmbeddingProvider } from "../memory/embedding/types.ts";
import { resolveAnchorInFile, verifyStep, type StepVerification } from "./anchors.ts";
import {
  describeDrift,
  evaluateDecay,
  gitFileExists,
  resolveCanonicalRef,
  routeDrift,
} from "./freshness.ts";
import { createTaskRouteStore } from "./store/factory.ts";
import type { TaskRouteStore } from "./store/interface.ts";
import {
  MAX_ROUTE_STEPS,
  type StepRepair,
  type StepStatus,
  type TaskRouteRecord,
  type TaskRouteStepInput,
  type TaskRouteStepRecord,
  type VerificationTier,
  type VerifiedBy,
} from "./types.ts";

/**
 * `route_fetch` / `route_save` / `route_report_usage`.
 *
 * None of these calls an LLM. The intelligence is in the caller: which files
 * mattered is not inferrable from a transcript, so only the agent that did the
 * work can write the route, and only it can say which steps it actually used.
 */

/**
 * Cosine floor for the semantic fallback. Below this the corpus has nothing for
 * the task, and handing back the nearest unrelated route is worse than a blank
 * page — the reader cannot tell a bad match from a stale one.
 */
const SEMANTIC_MIN_COSINE = 0.35;

export interface TaskRouteToolDeps {
  store: TaskRouteStore;
  embedder: EmbeddingProvider;
  /** Absolute checkout path for a repo, or null when it is not on this box. */
  resolveRepoPath(repo: string): string | null;
  /** The repo's configured default base (`RepoConfig.defaultBase`). */
  resolveDefaultBase?(repo: string): string | undefined;
  now?(): number;
}

// --- route_save -------------------------------------------------------------

export interface RouteSaveArgs {
  repo: string;
  feature: string;
  taskKind: string;
  taskDesc: string;
  steps: TaskRouteStepInput[];
}

export interface RouteSaveResult {
  route_id: string;
  resolved: number;
  unresolved: Array<{
    ord: number;
    path: string | null;
    symbol: string | null;
    reason: string;
  }>;
  verified_sha: string;
  ref: string | null;
  /**
   * False when nothing could be anchored on the canonical ref — the route is
   * stored but not searchable until a later fetch finds its anchors merged.
   */
  active: boolean;
}

/**
 * Resolve and fingerprint every step AGAINST THE CANONICAL REF, then upsert on
 * the `(repo, feature, task_kind)` identity in one transaction with its steps.
 *
 * Save deliberately does not read the working tree. It fires at the end of a
 * turn, which usually means an unmerged feature worktree; anchors resolved
 * there may not exist on the default branch at all, and the very first fetch
 * would then report them gone or repair them against the wrong tree. Anchors
 * that do not resolve on the ref are recorded PENDING (no fingerprints) and do
 * not count as verified until a later fetch finds them.
 */
export async function routeSave(
  args: RouteSaveArgs,
  deps: TaskRouteToolDeps,
): Promise<RouteSaveResult> {
  const repo = required(args.repo, "repo");
  const feature = required(args.feature, "feature");
  const taskKind = required(args.taskKind, "task_kind");
  const taskDesc = required(args.taskDesc, "task_desc");
  if (args.steps.length === 0) {
    throw new Error("route_save: a route needs at least one step");
  }
  if (args.steps.length > MAX_ROUTE_STEPS) {
    throw new Error(
      `route_save: ${args.steps.length} steps exceeds the ${MAX_ROUTE_STEPS}-step cap. ` +
        "Longer than that and you have written a code index — write the code index " +
        "and have the route point at it.",
    );
  }

  const ctx = await resolveCanonicalRef(
    repoPathFor(repo, deps),
    deps.resolveDefaultBase?.(repo),
  );

  const steps: TaskRouteStepRecord[] = [];
  const unresolved: RouteSaveResult["unresolved"] = [];
  let anchored = 0;
  let resolved = 0;

  for (const [index, input] of args.steps.entries()) {
    const ord = index + 1;
    const note = required(input.note, `steps[${index}].note`);
    const path = blankToNull(input.path);
    const symbol = blankToNull(input.symbol);
    const step: TaskRouteStepRecord = {
      ord,
      note,
      path,
      symbol,
      declPattern: null,
      sigHash: null,
      blockHash: null,
      expectsRef: blankToNull(input.expectsRef),
      touchCount: 0,
    };
    steps.push(step);
    // A pure tooling note ("the Chrome extension is not connected") has nothing
    // to anchor and cannot rot. It gets equal billing, not a fingerprint.
    if (!path) continue;
    anchored += 1;

    if (!ctx) {
      unresolved.push({ ord, path, symbol, reason: "repo or canonical ref unavailable" });
      continue;
    }
    if (!symbol) {
      if (await gitFileExists(ctx, path)) resolved += 1;
      else unresolved.push({ ord, path, symbol, reason: `path not on ${ctx.ref}` });
      continue;
    }
    const anchor = await resolveAnchorInFile(ctx, path, symbol);
    if (!anchor) {
      unresolved.push({
        ord,
        path,
        symbol,
        reason: `symbol not found on ${ctx.ref} (pending until it merges)`,
      });
      continue;
    }
    step.path = anchor.path;
    step.declPattern = anchor.declPattern;
    step.sigHash = anchor.sigHash;
    step.blockHash = anchor.blockHash;
    resolved += 1;
  }

  // A route whose anchors all failed to resolve is not activated — it would
  // otherwise be searchable while claiming knowledge of a tree it was never
  // checked against. A route of pure tooling notes has nothing to resolve and
  // nothing to rot, so it is active on the spot.
  const active = anchored === 0 || resolved > 0;
  const [embedding] = await deps.embedder.embed([taskDesc], "document");
  const record = await deps.store.upsertRoute({
    id: routeId(repo, feature, taskKind),
    repo,
    feature,
    taskKind,
    taskDesc,
    embedding,
    embedModel: deps.embedder.model,
    dim: deps.embedder.dim,
    verifiedSha: ctx?.sha ?? "",
    createdAt: (deps.now ?? Date.now)(),
    active,
    steps,
  });

  return {
    route_id: record.id,
    resolved,
    unresolved,
    verified_sha: record.verifiedSha,
    ref: ctx?.ref ?? null,
    active: record.active,
  };
}

// --- route_fetch ------------------------------------------------------------

export interface RouteFetchArgs {
  repo: string;
  /** Natural-language description of the task, for the semantic fallback. */
  task: string;
  feature?: string;
  taskKind?: string;
}

export interface RouteFetchStep {
  ord: number;
  note: string;
  path: string | null;
  symbol: string | null;
  status: StepStatus;
  resolved_path?: string;
  /** Which tier answered — `fingerprint` is stronger evidence than `path-only`. */
  verified_by: VerifiedBy;
  tier: VerificationTier;
  expects_ref?: string;
}

export interface RouteFetchResult {
  found: true;
  route_id: string;
  repo: string;
  feature: string;
  task_kind: string;
  task_desc: string;
  verified_sha: string;
  /** The ref everything was verified against, or null when it is unreachable. */
  ref: string | null;
  /** "untouched" | "N commits" | "unknown" — scoped to the route's own paths. */
  drift: string;
  matched_by: "identity" | "semantic";
  steps: RouteFetchStep[];
  confidence: Record<StepStatus, number>;
  /** Ords whose anchors were rewritten by this fetch, with no agent involvement. */
  repaired: number[];
  active: boolean;
  archived: boolean;
}

export interface RouteFetchMiss {
  found: false;
  repo: string;
  reason: string;
}

/**
 * Look the route up (exact identity first, cosine second), verify every step
 * against the canonical ref, auto-repair what moved, and record the fetch.
 */
export async function routeFetch(
  args: RouteFetchArgs,
  deps: TaskRouteToolDeps,
): Promise<RouteFetchResult | RouteFetchMiss> {
  const repo = required(args.repo, "repo");
  const now = (deps.now ?? Date.now)();

  const match = await lookupRoute(repo, args, deps);
  if (!match) {
    return { found: false, repo, reason: "no route for this repo/feature/task-kind" };
  }
  const route = match.route;

  const ctx = await resolveCanonicalRef(
    repoPathFor(repo, deps),
    deps.resolveDefaultBase?.(repo),
  );

  // Repo absent or ref unresolvable: every step is `unknown`, never `ok`. An
  // unverified route that claims to be verified is the exact failure mode this
  // annotation exists to prevent.
  if (!ctx) {
    const verifications = route.steps.map((step): StepVerification => ({
      ord: step.ord,
      status: step.path ? "unknown" : "note",
      tier: null,
      verifiedBy: "none",
    }));
    // The fetch happened, so it counts; the broken streak does not advance,
    // because an unreadable repo is no evidence at all about the route.
    await deps.store.recordFetch(route.id, { now, repairs: [], brokenFetches: 0 });
    return buildResult(route, verifications, {
      ref: null,
      drift: "unknown",
      verifiedSha: route.verifiedSha,
      matchedBy: match.matchedBy,
      repairs: [],
      active: route.active,
      archived: false,
    });
  }

  const drift = await routeDrift(
    ctx,
    route.verifiedSha,
    route.steps.map((step) => step.path).filter((p): p is string => p !== null),
  );

  const verifications: StepVerification[] = [];
  for (const step of route.steps) {
    const untouched =
      drift.commits === 0 ||
      (drift.commits !== null && step.path !== null && !drift.changedPaths.has(step.path));
    verifications.push(await verifyStep(ctx, step, { untouched }));
  }

  const repairs = verifications
    .map((verification) => verification.repair)
    .filter((repair): repair is StepRepair => repair !== undefined);
  const statuses = verifications.map((verification) => verification.status);
  const decay = evaluateDecay(statuses, route.brokenFetches, repairs.length > 0);
  // Activation is the mirror of archival: a route saved from an unmerged branch
  // comes alive as soon as its anchors land on the canonical ref.
  const anyVerified = statuses.some(
    (status) => status === "ok" || status === "untouched" || status === "moved",
  );
  const active = decay.archive ? false : route.active || anyVerified;

  // Bump `verified_sha` only when NOTHING is left outstanding. Bumping while a
  // step is still drifted would make the next fetch report tier-0 `untouched`
  // and never look at it again — the drift signal would be erased by the
  // repair of an unrelated step.
  const clean = statuses.every(
    (status) => status === "ok" || status === "untouched" || status === "moved" || status === "note",
  );

  await deps.store.recordFetch(route.id, {
    now,
    repairs,
    brokenFetches: decay.brokenFetches,
    ...(clean ? { verifiedSha: ctx.sha } : {}),
    ...(active !== route.active ? { active } : {}),
  });

  return buildResult(route, verifications, {
    ref: ctx.ref,
    drift: describeDrift(drift),
    verifiedSha: clean ? ctx.sha : route.verifiedSha,
    matchedBy: match.matchedBy,
    repairs,
    active,
    archived: decay.archive,
  });
}

interface RouteMatch {
  route: TaskRouteRecord;
  matchedBy: "identity" | "semantic";
}

/**
 * Two-stage lookup, most precise first. Exact `(repo, feature, task_kind)` is
 * the common case, because the orchestrator dispatching the task already knows
 * all three; cosine over `task_desc` is the fallback. Exact lookup deliberately
 * ignores `active` so a pending or archived route can still be revived, while
 * search only ever returns active routes.
 */
async function lookupRoute(
  repo: string,
  args: RouteFetchArgs,
  deps: TaskRouteToolDeps,
): Promise<RouteMatch | null> {
  if (args.feature && args.taskKind) {
    const exact = await deps.store.getRouteByIdentity(repo, args.feature, args.taskKind);
    if (exact) return { route: exact, matchedBy: "identity" };
  }
  const task = args.task?.trim();
  if (!task) return null;
  const [queryVector] = await deps.embedder.embed([task], "query");
  const results = await deps.store.recallRoutes({
    queryVector,
    repo,
    ...(args.feature ? { feature: args.feature } : {}),
    limit: 1,
  });
  const best = results[0];
  if (!best || best.cosine === null || best.cosine < SEMANTIC_MIN_COSINE) return null;
  return { route: best.route, matchedBy: "semantic" };
}

function buildResult(
  route: TaskRouteRecord,
  verifications: StepVerification[],
  meta: {
    ref: string | null;
    drift: string;
    /** The sha as of AFTER this fetch's bookkeeping, not the row we read. */
    verifiedSha: string;
    matchedBy: "identity" | "semantic";
    repairs: StepRepair[];
    active: boolean;
    archived: boolean;
  },
): RouteFetchResult {
  const byOrd = new Map(verifications.map((v) => [v.ord, v]));
  const confidence = emptyConfidence();
  const steps: RouteFetchStep[] = route.steps.map((step) => {
    const verification = byOrd.get(step.ord);
    const status = verification?.status ?? "unknown";
    confidence[status] += 1;
    return {
      ord: step.ord,
      note: step.note,
      // Report the repaired location, not the one the caller would have read.
      path: verification?.resolvedPath ?? step.path,
      symbol: step.symbol,
      status,
      ...(verification?.resolvedPath ? { resolved_path: verification.resolvedPath } : {}),
      verified_by: verification?.verifiedBy ?? "none",
      tier: verification?.tier ?? null,
      ...(step.expectsRef ? { expects_ref: step.expectsRef } : {}),
    };
  });
  return {
    found: true,
    route_id: route.id,
    repo: route.repo,
    feature: route.feature,
    task_kind: route.taskKind,
    task_desc: route.taskDesc,
    verified_sha: meta.verifiedSha,
    ref: meta.ref,
    drift: meta.drift,
    matched_by: meta.matchedBy,
    steps,
    confidence,
    repaired: meta.repairs.map((repair) => repair.ord),
    active: meta.active,
    archived: meta.archived,
  };
}

/**
 * Per-step status counts. Deliberately NOT collapsed to a single staleness
 * scalar: a route 90% fresh whose entry point moved is worse than one 60% fresh
 * with a valid entry point.
 */
function emptyConfidence(): Record<StepStatus, number> {
  return {
    untouched: 0,
    ok: 0,
    drifted: 0,
    moved: 0,
    gone: 0,
    "edge-broken": 0,
    pending: 0,
    unknown: 0,
    note: 0,
  };
}

// --- route_report_usage -----------------------------------------------------

export interface RouteReportUsageResult {
  ok: boolean;
  updated: number;
  reason?: string;
}

/**
 * Explicit, because Junior cannot observe an agent's file reads — nothing in
 * the runner boundary reports which paths a subagent opened. Without this call
 * `touch_count` has no writer at all.
 *
 * The counter is INFORMATIONAL for now. Usage-weighted pruning ships only once
 * the reports are actually arriving; a pruning rule driven by a counter that
 * stays zero would quietly delete a working route's steps.
 */
export async function routeReportUsage(
  args: { routeId: string; usedOrds: number[] },
  deps: Pick<TaskRouteToolDeps, "store">,
): Promise<RouteReportUsageResult> {
  const routeId = required(args.routeId, "route_id");
  const route = await deps.store.getRoute(routeId);
  if (!route) return { ok: false, updated: 0, reason: `unknown route ${routeId}` };
  const updated = await deps.store.recordUsage(routeId, args.usedOrds);
  return { ok: true, updated };
}

// --- MCP registration -------------------------------------------------------

export interface TaskRouteToolRuntime {
  /** Same SQLite file as memory v3 (`MEMORY_DB_PATH`). */
  dbPath: string;
  /** Lazy — the local provider loads a ~500MB model on first use. */
  getEmbedder(): Promise<EmbeddingProvider>;
  resolveRepoPath(repo: string): string | null;
  resolveDefaultBase?(repo: string): string | undefined;
}

const STEP_SCHEMA = z.object({
  note: z.string().min(1).max(2_000).describe("Why this step, one sentence"),
  path: z.string().max(500).optional().describe("Repo-relative path; omit for a pure tooling note"),
  symbol: z
    .string()
    .max(200)
    .optional()
    .describe("Function / const / section marker to anchor on inside `path`"),
  expects_ref: z
    .string()
    .max(500)
    .optional()
    .describe("Text this file should still contain — the far end of an edge the step records"),
});

/**
 * Register the route tools on the shared MCP server. They go to the WORKING
 * agent: the recall/consolidation path sees what was read but not which reads
 * were dead ends, and only the agent that did the work knows the difference.
 */
export function registerTaskRouteTools(
  server: McpServer,
  runtime: TaskRouteToolRuntime,
): void {
  const withStore = async <T>(fn: (store: TaskRouteStore) => Promise<T>): Promise<T> => {
    const store = createTaskRouteStore(runtime.dbPath);
    try {
      return await fn(store);
    } finally {
      store.close();
    }
  };
  // Only the tools that embed pay for the embedder — the local provider loads a
  // ~500MB model on first use, and a usage report has nothing to embed.
  const withDeps = async <T>(fn: (deps: TaskRouteToolDeps) => Promise<T>): Promise<T> =>
    withStore(async (store) =>
      fn({
        store,
        embedder: await runtime.getEmbedder(),
        resolveRepoPath: runtime.resolveRepoPath,
        ...(runtime.resolveDefaultBase
          ? { resolveDefaultBase: runtime.resolveDefaultBase }
          : {}),
      }),
    );

  registerTool(
    server,
    "route_fetch",
    {
      description:
        "Has anyone done this kind of task on this feature before? Returns a stored, ordered path " +
        "through the codebase — entry point, order, and tooling dead ends — instead of a blank page. " +
        "Call it as step 0 of any task touching a known feature area. Every step is re-verified " +
        "against origin/<default-branch> at fetch time and reports WHICH tier answered " +
        "(git-untouched > fingerprint > decl-pattern > path-only); `unknown` means the repo or ref " +
        "could not be read, never that the step is fine. Symbols that merely moved are repaired in place.",
      inputSchema: {
        repo: z.string().min(1).max(200).describe("Repo name, e.g. 'junior', 'gx-backend'"),
        task: z.string().min(1).max(2_000).describe("What you are about to do, in a sentence"),
        feature: z.string().max(200).optional().describe("Feature area, e.g. 'dashboard-memory-view'"),
        task_kind: z
          .string()
          .max(200)
          .optional()
          .describe("Task kind, e.g. 'add-ui-surface', 'add-endpoint', 'debug-*'"),
      },
    },
    async ({ repo, task, feature, task_kind }) =>
      withDeps(async (deps) =>
        toolResult(
          await routeFetch(
            {
              repo,
              task,
              ...(feature ? { feature } : {}),
              ...(task_kind ? { taskKind: task_kind } : {}),
            },
            deps,
          ),
        ),
      ),
  );

  registerTool(
    server,
    "route_save",
    {
      description:
        "Record the path you just took through a codebase so the next agent does not re-pay the cost " +
        "of locating the code. Write it only when the task crossed 2+ modules or hit a tooling dead " +
        `end. HARD CAP ${MAX_ROUTE_STEPS} STEPS — longer than that and you have written a code index, ` +
        "so write the code index and have the route point at it. Tooling dead ends ('the Chrome " +
        "extension is not connected; use local Playwright with executablePath …') get equal billing " +
        "with file paths — omit `path` for those. Anchors are resolved against " +
        "origin/<default-branch>, so steps that only exist on your unmerged branch come back pending. " +
        "Overwrites any existing route for the same (repo, feature, task_kind).",
      inputSchema: {
        repo: z.string().min(1).max(200),
        feature: z.string().min(1).max(200).describe("Feature area, e.g. 'dashboard-memory-view'"),
        task_kind: z.string().min(1).max(200).describe("e.g. 'add-ui-surface', 'add-endpoint'"),
        task_desc: z
          .string()
          .min(1)
          .max(2_000)
          .describe("Natural language description of the task; embedded for recall"),
        steps: z.array(STEP_SCHEMA).min(1).max(MAX_ROUTE_STEPS),
      },
    },
    async ({ repo, feature, task_kind, task_desc, steps }) =>
      withDeps(async (deps) => {
        try {
          return toolResult(
            await routeSave(
              {
                repo,
                feature,
                taskKind: task_kind,
                taskDesc: task_desc,
                steps: steps.map((step) => ({
                  note: step.note,
                  ...(step.path ? { path: step.path } : {}),
                  ...(step.symbol ? { symbol: step.symbol } : {}),
                  ...(step.expects_ref ? { expectsRef: step.expects_ref } : {}),
                })),
              },
              deps,
            ),
          );
        } catch (error) {
          return toolResult(
            { ok: false, error: error instanceof Error ? error.message : String(error) },
            true,
          );
        }
      }),
  );

  registerTool(
    server,
    "route_report_usage",
    {
      description:
        "Report which steps of a fetched route you actually used, at the end of your task. Junior " +
        "cannot observe your file reads — route_fetch returns suggestions and never learns what " +
        "happened next — so this is the only writer of the usage signal.",
      inputSchema: {
        route_id: z.string().min(1).max(300),
        used_ords: z.array(z.number().int().positive()).max(MAX_ROUTE_STEPS),
      },
    },
    async ({ route_id, used_ords }) =>
      withStore(async (store) =>
        toolResult(await routeReportUsage({ routeId: route_id, usedOrds: used_ords }, { store })),
      ),
  );
}

function toolResult(payload: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * Deterministic id from the identity, so the primary-key conflict and the
 * unique-index conflict are always the same row.
 */
function routeId(repo: string, feature: string, taskKind: string): string {
  return `route_${slug(repo)}__${slug(feature)}__${slug(taskKind)}`;
}

function slug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * The configured checkout, falling back to the process cwd when Junior is
 * itself the repo in question (Junior's own workspace is not in REPOS).
 */
function repoPathFor(repo: string, deps: TaskRouteToolDeps): string | null {
  const configured = deps.resolveRepoPath(repo);
  if (configured) return configured;
  const cwd = process.cwd();
  return basename(cwd) === repo ? cwd : null;
}

function required(value: string | undefined, field: string): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) throw new Error(`route tools: \`${field}\` is required`);
  return trimmed;
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}
