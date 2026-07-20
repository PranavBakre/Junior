import { createHash } from "node:crypto";
import { checkCapability } from "../agents/capabilities.ts";
import type { SlackMcpRunContext } from "../mcp/context.ts";

const MAX_REVIEW_BODY_LENGTH = 20_000;
const MAX_COMMENT_BODY_LENGTH = 10_000;
const MAX_INLINE_COMMENTS = 100;
const inFlightReviews = new Map<string, Promise<PostGitHubReviewResult>>();

export const GITHUB_POST_REVIEW_TOOL =
  "mcp__slack-bot__github_post_review";
export const GITHUB_READ_REVIEW_STATE_TOOL =
  "mcp__slack-bot__github_read_pr_review_state";

const MAX_READ_REVIEW_ITEMS = 100;

export interface GitHubInlineReviewComment {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
  startLine?: number;
  startSide?: "LEFT" | "RIGHT";
}

export interface GitHubReviewInput {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  body: string;
  comments: GitHubInlineReviewComment[];
  idempotencyKey: string;
}

export interface GitHubApiRequest {
  method: "GET" | "POST";
  endpoint: string;
  body?: unknown;
  paginate?: boolean;
}

export interface GitHubApiResult {
  ok: boolean;
  status: number;
  stdout: string;
  stderr: string;
}

export type GitHubApiRunner = (
  request: GitHubApiRequest,
) => Promise<GitHubApiResult>;

export type PostGitHubReviewResult =
  | {
      ok: true;
      alreadyPosted: boolean;
      reviewId: number;
      reviewUrl: string | null;
      inlineComments: number;
      headSha: string;
    }
  | { ok: false; reason: string };

export interface GitHubReviewStateInput {
  owner: string;
  repo: string;
  prNumber: number;
  reviewId?: number;
}

export type ReadGitHubReviewStateResult =
  | {
      ok: true;
      headSha: string;
      reviewCount: number;
      inlineCommentCount: number;
      reviewIdFilter: number | null;
      reviews: Array<{
        id: number | null;
        author: string | null;
        state: string | null;
        body: string;
        commitId: string | null;
        submittedAt: string | null;
        url: string | null;
      }>;
      inlineComments: Array<{
        id: number | null;
        author: string | null;
        body: string;
        path: string | null;
        line: number | null;
        commitId: string | null;
        createdAt: string | null;
        url: string | null;
      }>;
    }
  | { ok: false; reason: string };

/**
 * Read bounded PR review state through fixed GET endpoints. No caller input is
 * ever interpreted as a gh flag or HTTP method.
 */
export async function readGitHubReviewState(
  runContext: SlackMcpRunContext | null,
  input: GitHubReviewStateInput,
  runApi: GitHubApiRunner = runGitHubApi,
): Promise<ReadGitHubReviewStateResult> {
  if (!runContext?.signed) {
    return { ok: false, reason: "signed MCP run context required" };
  }
  const capability = checkCapability(runContext.agent, "github-review-read");
  if (!capability.ok) return { ok: false, reason: capability.reason };

  const validationError = validateReviewTarget(input);
  if (validationError) return { ok: false, reason: validationError };

  const pullEndpoint = `repos/${input.owner}/${input.repo}/pulls/${input.prNumber}`;
  const commentsEndpoint = input.reviewId
    ? `${pullEndpoint}/reviews/${input.reviewId}/comments?per_page=100`
    : `${pullEndpoint}/comments?per_page=100`;
  const [pullResult, reviewsResult, commentsResult] = await Promise.all([
    runApi({ method: "GET", endpoint: pullEndpoint }),
    runApi({
      method: "GET",
      endpoint: `${pullEndpoint}/reviews?per_page=100`,
      paginate: true,
    }),
    runApi({
      method: "GET",
      endpoint: commentsEndpoint,
      paginate: true,
    }),
  ]);
  if (!pullResult.ok) return apiFailure("read PR head", pullResult);
  if (!reviewsResult.ok) return apiFailure("read PR reviews", reviewsResult);
  if (!commentsResult.ok) {
    return apiFailure("read PR inline comments", commentsResult);
  }

  const headSha = nestedString(parseJsonObject(pullResult.stdout), "head", "sha");
  if (!headSha) {
    return { ok: false, reason: "GitHub response omitted pull request head SHA" };
  }
  const reviews = parseJsonPages(reviewsResult.stdout);
  const inlineComments = parseJsonPages(commentsResult.stdout);

  return {
    ok: true,
    headSha,
    reviewCount: reviews.length,
    inlineCommentCount: inlineComments.length,
    reviewIdFilter: input.reviewId ?? null,
    reviews: reviews.slice(-MAX_READ_REVIEW_ITEMS).map((review) => ({
      id: positiveInteger(review.id),
      author: nestedString(review, "user", "login"),
      state: optionalString(review.state),
      body: boundedString(review.body),
      commitId: optionalString(review.commit_id),
      submittedAt: optionalString(review.submitted_at),
      url: optionalString(review.html_url),
    })),
    inlineComments: inlineComments
      .slice(-MAX_READ_REVIEW_ITEMS)
      .map((comment) => ({
        id: positiveInteger(comment.id),
        author: nestedString(comment, "user", "login"),
        body: boundedString(comment.body),
        path: optionalString(comment.path),
        line: positiveInteger(comment.line),
        commitId: optionalString(comment.commit_id),
        createdAt: optionalString(comment.created_at),
        url: optionalString(comment.html_url),
      })),
  };
}

/**
 * Post one COMMENT review at an exact PR head through a capability-scoped API.
 * The fixed endpoint cannot merge, push, edit code, approve, or request changes.
 */
export async function postGitHubReview(
  runContext: SlackMcpRunContext | null,
  input: GitHubReviewInput,
  runApi: GitHubApiRunner = runGitHubApi,
): Promise<PostGitHubReviewResult> {
  if (!runContext?.signed) {
    return { ok: false, reason: "signed MCP run context required" };
  }

  const capability = checkCapability(
    runContext.agent,
    "github-review-comment",
  );
  if (!capability.ok) {
    return { ok: false, reason: capability.reason };
  }

  const validationError = validateReviewInput(input);
  if (validationError) return { ok: false, reason: validationError };

  const marker = idempotencyMarker(input);
  const pending = inFlightReviews.get(marker);
  if (pending) return pending;

  const operation = postGitHubReviewOnce(input, marker, runApi);
  inFlightReviews.set(marker, operation);
  try {
    return await operation;
  } finally {
    if (inFlightReviews.get(marker) === operation) {
      inFlightReviews.delete(marker);
    }
  }
}

async function postGitHubReviewOnce(
  input: GitHubReviewInput,
  marker: string,
  runApi: GitHubApiRunner,
): Promise<PostGitHubReviewResult> {

  const pullEndpoint = `repos/${input.owner}/${input.repo}/pulls/${input.prNumber}`;
  const pullResult = await runApi({ method: "GET", endpoint: pullEndpoint });
  if (!pullResult.ok) {
    return apiFailure("read PR head", pullResult);
  }

  const pull = parseJsonObject(pullResult.stdout);
  const currentHead = nestedString(pull, "head", "sha");
  if (!currentHead) {
    return { ok: false, reason: "GitHub response omitted pull request head SHA" };
  }
  if (currentHead.toLowerCase() !== input.headSha.toLowerCase()) {
    return {
      ok: false,
      reason: `PR head moved: expected ${input.headSha}, current ${currentHead}`,
    };
  }

  const reviewsEndpoint = `${pullEndpoint}/reviews?per_page=100`;
  const reviewsResult = await runApi({
    method: "GET",
    endpoint: reviewsEndpoint,
    paginate: true,
  });
  if (!reviewsResult.ok) {
    return apiFailure("check existing reviews", reviewsResult);
  }

  const existing = parseJsonPages(reviewsResult.stdout).find(
    (review) =>
      typeof review.body === "string" && review.body.includes(marker),
  );
  if (existing) {
    return summarizeReview(input, existing, true, runApi);
  }

  const createResult = await runApi({
    method: "POST",
    endpoint: `${pullEndpoint}/reviews`,
    body: {
      commit_id: input.headSha,
      body: `${input.body.trim()}\n\n${marker}`,
      event: "COMMENT",
      comments: input.comments.map((comment) => ({
        path: comment.path,
        line: comment.line,
        side: comment.side,
        body: comment.body,
        ...(comment.startLine !== undefined
          ? { start_line: comment.startLine }
          : {}),
        ...(comment.startSide !== undefined
          ? { start_side: comment.startSide }
          : {}),
      })),
    },
  });
  if (!createResult.ok) {
    return apiFailure("post COMMENT review", createResult);
  }

  return summarizeReview(
    input,
    parseJsonObject(createResult.stdout),
    false,
    runApi,
  );
}

async function summarizeReview(
  input: GitHubReviewInput,
  review: Record<string, unknown>,
  alreadyPosted: boolean,
  runApi: GitHubApiRunner,
): Promise<PostGitHubReviewResult> {
  const reviewId = positiveInteger(review.id);
  if (!reviewId) {
    return { ok: false, reason: "GitHub response omitted review id" };
  }

  const commentsResult = await runApi({
    method: "GET",
    endpoint: `repos/${input.owner}/${input.repo}/pulls/${input.prNumber}/reviews/${reviewId}/comments?per_page=100`,
  });
  if (!commentsResult.ok) {
    return apiFailure("verify posted review comments", commentsResult);
  }
  const inlineComments = parseJsonArray(commentsResult.stdout).length;
  if (inlineComments !== input.comments.length) {
    return {
      ok: false,
      reason:
        `GitHub created review ${reviewId}, but verified ${inlineComments} inline comments ` +
        `instead of ${input.comments.length}`,
    };
  }

  return {
    ok: true,
    alreadyPosted,
    reviewId,
    reviewUrl: typeof review.html_url === "string" ? review.html_url : null,
    inlineComments,
    headSha: input.headSha,
  };
}

function validateReviewInput(input: GitHubReviewInput): string | null {
  const targetError = validateReviewTarget(input);
  if (targetError) return targetError;
  if (!/^[a-f0-9]{40}$/i.test(input.headSha)) {
    return "headSha must be a full 40-character Git SHA";
  }
  const body = input.body.trim();
  if (!body || body.length > MAX_REVIEW_BODY_LENGTH) {
    return `review body must be 1-${MAX_REVIEW_BODY_LENGTH} characters`;
  }
  if (
    !input.idempotencyKey.trim() ||
    input.idempotencyKey.length > 200
  ) {
    return "idempotencyKey must be 1-200 characters";
  }
  if (input.comments.length > MAX_INLINE_COMMENTS) {
    return `at most ${MAX_INLINE_COMMENTS} inline comments are allowed`;
  }
  for (const [index, comment] of input.comments.entries()) {
    if (!validRepoPath(comment.path)) {
      return `comments[${index}].path must be a relative repository path without '..'`;
    }
    if (!Number.isInteger(comment.line) || comment.line <= 0) {
      return `comments[${index}].line must be a positive integer`;
    }
    if (!comment.body.trim() || comment.body.length > MAX_COMMENT_BODY_LENGTH) {
      return `comments[${index}].body must be 1-${MAX_COMMENT_BODY_LENGTH} characters`;
    }
    if (comment.startLine !== undefined) {
      if (
        !Number.isInteger(comment.startLine) ||
        comment.startLine <= 0 ||
        comment.startLine > comment.line
      ) {
        return `comments[${index}].startLine must be positive and no greater than line`;
      }
      if (!comment.startSide) {
        return `comments[${index}].startSide is required with startLine`;
      }
    } else if (comment.startSide !== undefined) {
      return `comments[${index}].startLine is required with startSide`;
    }
  }
  return null;
}

function validateReviewTarget(input: GitHubReviewStateInput): string | null {
  const coord = /^[A-Za-z0-9_.-]+$/;
  if (!coord.test(input.owner)) return "invalid GitHub owner";
  if (!coord.test(input.repo)) return "invalid GitHub repository";
  if (!Number.isInteger(input.prNumber) || input.prNumber <= 0) {
    return "prNumber must be a positive integer";
  }
  if (
    input.reviewId !== undefined &&
    (!Number.isInteger(input.reviewId) || input.reviewId <= 0)
  ) {
    return "reviewId must be a positive integer";
  }
  return null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function boundedString(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 10_000) : "";
}

function validRepoPath(path: string): boolean {
  if (!path || path.length > 1_024 || path.startsWith("/") || path.includes("\0")) {
    return false;
  }
  return !path.split("/").some((segment) => segment === "..");
}

function idempotencyMarker(input: GitHubReviewInput): string {
  const digest = createHash("sha256")
    .update(
      `${input.owner}/${input.repo}#${input.prNumber}\n${input.headSha}\n${input.idempotencyKey}`,
    )
    .digest("hex");
  return `<!-- junior-review:${digest} -->`;
}

function apiFailure(
  action: string,
  result: GitHubApiResult,
): { ok: false; reason: string } {
  const detail = (result.stderr || result.stdout || `exit ${result.status}`)
    .trim()
    .slice(0, 1_000);
  return { ok: false, reason: `failed to ${action}: ${detail}` };
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseJsonArray(value: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter(
          (item): item is Record<string, unknown> =>
            !!item && typeof item === "object" && !Array.isArray(item),
        )
      : [];
  } catch {
    return [];
  }
}

function parseJsonPages(value: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    const pages = parsed.every((page) => Array.isArray(page))
      ? parsed.flat()
      : parsed;
    return pages.filter(
      (item): item is Record<string, unknown> =>
        !!item && typeof item === "object" && !Array.isArray(item),
    );
  } catch {
    return [];
  }
}

function nestedString(
  object: Record<string, unknown>,
  key: string,
  nestedKey: string,
): string | null {
  const nested = object[key];
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
    return null;
  }
  const value = (nested as Record<string, unknown>)[nestedKey];
  return typeof value === "string" ? value : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

async function runGitHubApi(
  request: GitHubApiRequest,
): Promise<GitHubApiResult> {
  const args = ["gh", "api", request.endpoint];
  if (request.method !== "GET") {
    args.push("--method", request.method, "--input", "-");
  }
  if (request.paginate) args.push("--paginate", "--slurp");

  const proc = Bun.spawn(args, {
    stdin: request.body === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GH_PROMPT_DISABLED: "1" },
  });
  if (request.body !== undefined && proc.stdin) {
    proc.stdin.write(JSON.stringify(request.body));
    proc.stdin.end();
  }
  const [stdout, stderr, status] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: status === 0, status, stdout, stderr };
}
