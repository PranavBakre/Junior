/**
 * Read-only GitHub client for PR reconciliation.
 *
 * Auth: GITHUB_RECONCILE_TOKEN (fine-grained, read-only intent). Optional
 * development fallback via `gh` CLI only when GITHUB_RECONCILE_USE_CLI=true.
 * Never uses merge-capable production tokens.
 */

import {
  NODES_PULL_REQUESTS_QUERY,
  OPEN_PRS_FOR_HEAD_REF_QUERY,
  PULL_REQUEST_BY_NUMBER_QUERY,
  type GraphQlPullRequestNode,
  type NodesQueryResponse,
  type OpenPrsForHeadRefResponse,
  type PullRequestByNumberResponse,
} from "./queries.ts";
import type {
  DriftDiscoveryResult,
  PrCheckRollupState,
  PrLifecycleState,
  PrMergeableState,
  PrReviewDecision,
  PrSnapshot,
} from "./types.ts";

const DEFAULT_API_URL = "https://api.github.com/graphql";
const DEFAULT_TIMEOUT_MS = 20_000;

export type FetchPrOk = {
  ok: true;
  nodeId: string;
  snapshot: PrSnapshot;
  rateLimitRemaining?: number;
};

export type FetchPrErr = {
  ok: false;
  error: string;
  rateLimited?: boolean;
  retryAfterMs?: number;
  invalidCredentials?: boolean;
  rateLimitRemaining?: number;
};

export type FetchPrResult = FetchPrOk | FetchPrErr;

export interface GitHubClient {
  fetchPullRequest(
    owner: string,
    repo: string,
    number: number,
  ): Promise<FetchPrResult>;
  fetchPullRequestsByNodeIds(
    nodeIds: string[],
  ): Promise<Map<string, FetchPrResult>>;
  /**
   * Drift repair only. Ambiguous open-PR sets escalate; never pick newest.
   */
  findOpenPrForHeadRef(
    owner: string,
    repo: string,
    headRef: string,
  ): Promise<DriftDiscoveryResult>;
}

export type GitHubClientOptions = {
  /** Read-only fine-grained token. Required unless useCli is true. */
  token?: string | null;
  /** Explicit opt-in for `gh api graphql` fallback (dev only). */
  useCli?: boolean;
  apiUrl?: string;
  timeoutMs?: number;
  /** Injectable fetch for tests. */
  fetchImpl?: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
  /** Injectable CLI runner for tests. */
  runCli?: (args: string[]) => Promise<{
    ok: boolean;
    status: number;
    body: string;
    headers: Record<string, string>;
  }>;
};

export function createGitHubClient(options: GitHubClientOptions = {}): GitHubClient {
  const token = options.token?.trim() || null;
  const useCli = options.useCli === true;
  if (!token && !useCli) {
    throw new Error(
      "GitHub client requires GITHUB_RECONCILE_TOKEN or GITHUB_RECONCILE_USE_CLI=true",
    );
  }

  const apiUrl = options.apiUrl ?? DEFAULT_API_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const runCli =
    options.runCli ??
    (async (args: string[]) => {
      const proc = Bun.spawn(["gh", ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const status = await proc.exited;
      return {
        ok: status === 0,
        status: status === 0 ? 200 : status,
        body: status === 0 ? stdout : stderr || stdout,
        headers: {},
      };
    });

  async function graphql<T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<
    | { ok: true; json: T; status: number; headers: Record<string, string> }
    | {
        ok: false;
        error: string;
        status: number;
        headers: Record<string, string>;
        body: string;
      }
  > {
    if (useCli && !token) {
      const result = await runCli([
        "api",
        "graphql",
        "-f",
        `query=${query}`,
        ...serializeCliVariables(variables),
      ]);
      if (!result.ok) {
        return {
          ok: false,
          error: result.body.slice(0, 500) || "gh api graphql failed",
          status: result.status,
          headers: result.headers,
          body: result.body,
        };
      }
      try {
        return {
          ok: true,
          json: JSON.parse(result.body) as T,
          status: 200,
          headers: result.headers,
        };
      } catch {
        return {
          ok: false,
          error: "invalid JSON from gh api graphql",
          status: 200,
          headers: result.headers,
          body: result.body,
        };
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(apiUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "junior-github-reconciler",
          "X-Github-Next-Global-ID": "1",
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
      const headers = headerMap(response.headers);
      const body = await response.text();
      if (!response.ok) {
        return {
          ok: false,
          error: `GitHub GraphQL HTTP ${response.status}`,
          status: response.status,
          headers,
          body,
        };
      }
      try {
        return {
          ok: true,
          json: JSON.parse(body) as T,
          status: response.status,
          headers,
        };
      } catch {
        return {
          ok: false,
          error: "invalid JSON from GitHub GraphQL",
          status: response.status,
          headers,
          body,
        };
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "GitHub GraphQL request failed";
      return {
        ok: false,
        error: message,
        status: 0,
        headers: {},
        body: "",
      };
    } finally {
      clearTimeout(timer);
    }
  }

  function mapTransportError(
    status: number,
    headers: Record<string, string>,
    error: string,
    body: string,
  ): FetchPrErr {
    if (status === 401 || status === 403) {
      const lower = `${error} ${body}`.toLowerCase();
      if (
        status === 401 ||
        lower.includes("bad credentials") ||
        lower.includes("requires authentication") ||
        lower.includes("invalid token")
      ) {
        return {
          ok: false,
          error,
          invalidCredentials: true,
        };
      }
    }
    if (status === 403 || status === 429) {
      const retryAfterMs = parseRetryAfterMs(headers, body);
      const remaining = parseRateLimitRemaining(headers);
      if (
        status === 429 ||
        remaining === 0 ||
        /rate limit/i.test(`${error} ${body}`)
      ) {
        return {
          ok: false,
          error,
          rateLimited: true,
          retryAfterMs,
          rateLimitRemaining: remaining,
        };
      }
    }
    return { ok: false, error };
  }

  return {
    async fetchPullRequest(owner, repo, number) {
      const result = await graphql<PullRequestByNumberResponse>(
        PULL_REQUEST_BY_NUMBER_QUERY,
        { owner, repo, number },
      );
      if (!result.ok) {
        return mapTransportError(
          result.status,
          result.headers,
          result.error,
          result.body,
        );
      }
      if (result.json.errors?.length) {
        const msg = result.json.errors
          .map((e) => e.message ?? "unknown")
          .join("; ");
        if (/401|bad credentials|unauthorized/i.test(msg)) {
          return { ok: false, error: msg, invalidCredentials: true };
        }
        return { ok: false, error: msg };
      }
      const node = result.json.data?.repository?.pullRequest;
      if (!node) {
        return { ok: false, error: `PR not found: ${owner}/${repo}#${number}` };
      }
      const parsed = parsePullRequestNode(node);
      if (!parsed) {
        return { ok: false, error: "unparseable pull request node" };
      }
      return {
        ok: true,
        nodeId: parsed.nodeId,
        snapshot: parsed.snapshot,
        rateLimitRemaining: result.json.data?.rateLimit?.remaining,
      };
    },

    async fetchPullRequestsByNodeIds(nodeIds) {
      const out = new Map<string, FetchPrResult>();
      if (nodeIds.length === 0) return out;

      const result = await graphql<NodesQueryResponse>(
        NODES_PULL_REQUESTS_QUERY,
        { ids: nodeIds },
      );
      if (!result.ok) {
        const err = mapTransportError(
          result.status,
          result.headers,
          result.error,
          result.body,
        );
        for (const id of nodeIds) out.set(id, err);
        return out;
      }
      if (result.json.errors?.length) {
        // Partial success is possible with nodes(); map what we can.
        const hasAuth = result.json.errors.some((e) =>
          /401|bad credentials|unauthorized/i.test(e.message ?? ""),
        );
        if (hasAuth && !result.json.data?.nodes?.length) {
          const err: FetchPrErr = {
            ok: false,
            error: result.json.errors.map((e) => e.message).join("; "),
            invalidCredentials: true,
          };
          for (const id of nodeIds) out.set(id, err);
          return out;
        }
      }

      const nodes = result.json.data?.nodes ?? [];
      const remaining = result.json.data?.rateLimit?.remaining;
      for (let i = 0; i < nodeIds.length; i++) {
        const id = nodeIds[i]!;
        const node = nodes[i];
        if (!node || node.number == null) {
          out.set(id, {
            ok: false,
            error: `node missing or not a PullRequest: ${id}`,
          });
          continue;
        }
        const parsed = parsePullRequestNode(node);
        if (!parsed) {
          out.set(id, { ok: false, error: `unparseable node: ${id}` });
          continue;
        }
        out.set(id, {
          ok: true,
          nodeId: parsed.nodeId,
          snapshot: parsed.snapshot,
          rateLimitRemaining: remaining,
        });
      }
      return out;
    },

    async findOpenPrForHeadRef(owner, repo, headRef) {
      const result = await graphql<OpenPrsForHeadRefResponse>(
        OPEN_PRS_FOR_HEAD_REF_QUERY,
        { owner, repo, headRef },
      );
      if (!result.ok) {
        return { status: "error", message: result.error };
      }
      if (result.json.errors?.length) {
        return {
          status: "error",
          message: result.json.errors.map((e) => e.message).join("; "),
        };
      }
      const nodes =
        result.json.data?.repository?.pullRequests?.nodes?.filter(
          (n): n is NonNullable<typeof n> => n != null && n.number != null,
        ) ?? [];
      if (nodes.length === 0) return { status: "none" };
      if (nodes.length > 1) {
        return {
          status: "ambiguous",
          candidates: nodes.map((n) => ({
            number: n.number!,
            url: n.url ?? `https://github.com/${owner}/${repo}/pull/${n.number}`,
          })),
        };
      }
      const only = nodes[0]!;
      return {
        status: "found",
        owner,
        repo,
        number: only.number!,
        nodeId: only.id ?? null,
      };
    },
  };
}

function serializeCliVariables(
  variables: Record<string, unknown>,
): string[] {
  return Object.entries(variables).flatMap(([key, value]) => {
    if (Array.isArray(value)) {
      if (value.length === 0) return ["-F", `${key}[]`];
      return value.flatMap((item) => [
        "-F",
        `${key}[]=${serializeCliFieldValue(item)}`,
      ]);
    }
    return ["-F", `${key}=${serializeCliFieldValue(value)}`];
  });
}

function serializeCliFieldValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function parsePullRequestNode(
  node: GraphQlPullRequestNode,
): { nodeId: string; snapshot: PrSnapshot } | null {
  if (node.number == null || !node.headRefOid || !node.baseRefName) {
    return null;
  }
  const nodeId = node.id ?? "";
  if (!nodeId) return null;

  const state = deriveLifecycleState(node);
  const commit = node.commits?.nodes?.[0]?.commit;
  const checkRollupSha = commit?.oid ?? node.headRefOid;
  const checkRollup = normalizeCheckRollup(
    commit?.statusCheckRollup?.state ?? null,
  );

  const snapshot: PrSnapshot = {
    state,
    isDraft: Boolean(node.isDraft),
    baseRefName: node.baseRefName,
    headRefName: node.headRefName ?? "",
    headRefOid: node.headRefOid,
    reviewDecision: normalizeReviewDecision(node.reviewDecision ?? null),
    mergeable: normalizeMergeable(node.mergeable ?? null),
    mergedAt: node.mergedAt ?? null,
    closedAt: node.closedAt ?? null,
    checkRollup,
    checkRollupSha,
    updatedAt: node.updatedAt ?? null,
  };
  return { nodeId, snapshot };
}

function deriveLifecycleState(node: GraphQlPullRequestNode): PrLifecycleState {
  if (node.merged === true || node.state === "MERGED") return "MERGED";
  if (node.state === "CLOSED") return "CLOSED";
  if (node.state === "OPEN") return "OPEN";
  // GraphQL PullRequestState is OPEN | CLOSED; merged is a separate field.
  if (node.mergedAt) return "MERGED";
  if (node.closedAt) return "CLOSED";
  return "OPEN";
}

function normalizeReviewDecision(value: string | null): PrReviewDecision {
  if (
    value === "APPROVED" ||
    value === "CHANGES_REQUESTED" ||
    value === "REVIEW_REQUIRED" ||
    value === "DISMISSED"
  ) {
    return value;
  }
  return null;
}

function normalizeMergeable(value: string | null): PrMergeableState {
  if (value === "MERGEABLE" || value === "CONFLICTING" || value === "UNKNOWN") {
    return value;
  }
  return null;
}

function normalizeCheckRollup(value: string | null): PrCheckRollupState {
  if (
    value === "SUCCESS" ||
    value === "FAILURE" ||
    value === "PENDING" ||
    value === "ERROR" ||
    value === "EXPECTED"
  ) {
    return value;
  }
  return null;
}

function headerMap(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function parseRateLimitRemaining(
  headers: Record<string, string>,
): number | undefined {
  const raw =
    headers["x-ratelimit-remaining"] ?? headers["X-RateLimit-Remaining"];
  if (raw == null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function parseRetryAfterMs(
  headers: Record<string, string>,
  body: string,
): number | undefined {
  const retryAfter = headers["retry-after"] ?? headers["Retry-After"];
  if (retryAfter != null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.floor(seconds * 1000);
    }
  }
  const reset = headers["x-ratelimit-reset"] ?? headers["X-RateLimit-Reset"];
  if (reset != null) {
    const resetSec = Number(reset);
    if (Number.isFinite(resetSec)) {
      const ms = resetSec * 1000 - Date.now();
      if (ms > 0) return Math.floor(ms);
    }
  }
  // GraphQL secondary rate limit messages sometimes embed a wait hint.
  const match = /wait\s+(\d+)\s*(ms|milliseconds|s|seconds)?/i.exec(body);
  if (match) {
    const n = Number(match[1]);
    const unit = (match[2] ?? "s").toLowerCase();
    if (Number.isFinite(n)) {
      return unit.startsWith("ms") ? n : n * 1000;
    }
  }
  return undefined;
}
