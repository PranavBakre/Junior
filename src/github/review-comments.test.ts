import { describe, expect, it } from "bun:test";
import {
  postGitHubReview,
  readGitHubReviewState,
  type GitHubApiRequest,
  type GitHubApiRunner,
  type GitHubReviewInput,
} from "./review-comments.ts";

const SHA = "a".repeat(40);

function input(overrides: Partial<GitHubReviewInput> = {}): GitHubReviewInput {
  return {
    owner: "GrowthX-Club",
    repo: "gx-backend",
    prNumber: 123,
    headSha: SHA,
    body: "review: changes-requested — one blocker",
    idempotencyKey: `review:${SHA}`,
    comments: [
      {
        path: "src/index.ts",
        line: 12,
        side: "RIGHT",
        body: "**blocker:** this can lose data",
      },
    ],
    ...overrides,
  };
}

const reviewContext = {
  agent: "review",
  channel: "C123",
  threadId: "111.222",
  signed: true,
} as const;

function scriptedRunner(
  responses: Array<{ ok?: boolean; status?: number; body: unknown }>,
): { runner: GitHubApiRunner; calls: GitHubApiRequest[] } {
  const calls: GitHubApiRequest[] = [];
  const runner: GitHubApiRunner = async (request) => {
    calls.push(request);
    const response = responses.shift();
    if (!response) throw new Error(`unexpected request: ${request.endpoint}`);
    return {
      ok: response.ok ?? true,
      status: response.status ?? 0,
      stdout: typeof response.body === "string"
        ? response.body
        : JSON.stringify(response.body),
      stderr: response.ok === false ? String(response.body) : "",
    };
  };
  return { runner, calls };
}

describe("postGitHubReview", () => {
  it("posts one idempotent COMMENT review at the exact head and verifies comments", async () => {
    const { runner, calls } = scriptedRunner([
      { body: { head: { sha: SHA } } },
      { body: [[]] },
      {
        body: {
          id: 99,
          html_url: "https://github.com/GrowthX-Club/gx-backend/pull/123#pullrequestreview-99",
        },
      },
      { body: [{ id: 1 }] },
    ]);

    await expect(postGitHubReview(reviewContext, input(), runner)).resolves.toEqual({
      ok: true,
      alreadyPosted: false,
      reviewId: 99,
      reviewUrl:
        "https://github.com/GrowthX-Club/gx-backend/pull/123#pullrequestreview-99",
      inlineComments: 1,
      headSha: SHA,
    });

    expect(calls.map((call) => [call.method, call.endpoint])).toEqual([
      ["GET", "repos/GrowthX-Club/gx-backend/pulls/123"],
      ["GET", "repos/GrowthX-Club/gx-backend/pulls/123/reviews?per_page=100"],
      ["POST", "repos/GrowthX-Club/gx-backend/pulls/123/reviews"],
      ["GET", "repos/GrowthX-Club/gx-backend/pulls/123/reviews/99/comments?per_page=100"],
    ]);
    expect(calls[2]?.body).toMatchObject({
      commit_id: SHA,
      event: "COMMENT",
      comments: [
        {
          path: "src/index.ts",
          line: 12,
          side: "RIGHT",
          body: "**blocker:** this can lose data",
        },
      ],
    });
    expect((calls[2]?.body as { body: string }).body).toContain(
      "<!-- junior-review:",
    );
  });

  it("returns the existing review instead of duplicating a retried request", async () => {
    let marker = "";
    const first = scriptedRunner([
      { body: { head: { sha: SHA } } },
      { body: [[]] },
      { body: { id: 44, html_url: "https://example.test/review/44" } },
      { body: [{ id: 1 }] },
    ]);
    await postGitHubReview(reviewContext, input(), first.runner);
    marker = (first.calls[2]?.body as { body: string }).body.match(
      /<!-- junior-review:[a-f0-9]+ -->/,
    )?.[0] ?? "";

    const retry = scriptedRunner([
      { body: { head: { sha: SHA } } },
      {
        body: [[{ id: 44, html_url: "https://example.test/review/44", body: marker }]],
      },
      { body: [{ id: 1 }] },
    ]);

    await expect(postGitHubReview(reviewContext, input(), retry.runner)).resolves.toMatchObject({
      ok: true,
      alreadyPosted: true,
      reviewId: 44,
    });
    expect(retry.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("coalesces concurrent deliveries with the same idempotency key", async () => {
    const { runner, calls } = scriptedRunner([
      { body: { head: { sha: SHA } } },
      { body: [[]] },
      { body: { id: 45 } },
      { body: [{ id: 1 }] },
    ]);

    const [first, second] = await Promise.all([
      postGitHubReview(reviewContext, input(), runner),
      postGitHubReview(reviewContext, input(), runner),
    ]);

    expect(first).toEqual(second);
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("does not treat an incomplete existing review as a successful retry", async () => {
    const markerSource = scriptedRunner([
      { body: { head: { sha: SHA } } },
      { body: [[]] },
      { body: { id: 44 } },
      { body: [{ id: 1 }] },
    ]);
    await postGitHubReview(reviewContext, input(), markerSource.runner);
    const marker = (markerSource.calls[2]?.body as { body: string }).body.match(
      /<!-- junior-review:[a-f0-9]+ -->/,
    )?.[0] ?? "";
    const retry = scriptedRunner([
      { body: { head: { sha: SHA } } },
      { body: [[{ id: 44, body: marker }]] },
      { body: [] },
    ]);

    await expect(postGitHubReview(reviewContext, input(), retry.runner)).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("verified 0 inline comments instead of 1"),
    });
    expect(retry.calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("rejects unsigned, unauthorized, stale-head, and unsafe-path requests", async () => {
    const never: GitHubApiRunner = async () => {
      throw new Error("API should not be called");
    };
    await expect(
      postGitHubReview({ ...reviewContext, signed: false }, input(), never),
    ).resolves.toEqual({ ok: false, reason: "signed MCP run context required" });
    await expect(
      postGitHubReview({ ...reviewContext, agent: "reproducer" }, input(), never),
    ).resolves.toMatchObject({ ok: false });
    await expect(
      postGitHubReview(
        reviewContext,
        input({ comments: [{ path: "../secret", line: 1, side: "RIGHT", body: "bad" }] }),
        never,
      ),
    ).resolves.toMatchObject({ ok: false, reason: expect.stringContaining("relative repository path") });

    const stale = scriptedRunner([{ body: { head: { sha: "b".repeat(40) } } }]);
    await expect(postGitHubReview(reviewContext, input(), stale.runner)).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("PR head moved"),
    });
  });

  it("fails if GitHub does not verify the expected number of inline comments", async () => {
    const { runner } = scriptedRunner([
      { body: { head: { sha: SHA } } },
      { body: [[]] },
      { body: { id: 55 } },
      { body: [] },
    ]);
    await expect(postGitHubReview(reviewContext, input(), runner)).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("verified 0 inline comments instead of 1"),
    });
  });
});

describe("readGitHubReviewState", () => {
  it("uses only fixed GET endpoints and returns bounded review state", async () => {
    const { runner, calls } = scriptedRunner([
      { body: { head: { sha: SHA } } },
      {
        body: [[{
          id: 10,
          user: { login: "reviewer" },
          state: "COMMENTED",
          body: "review body",
          commit_id: SHA,
          submitted_at: "2026-07-20T00:00:00Z",
          html_url: "https://example.test/review/10",
        }]],
      },
      {
        body: [[{
          id: 20,
          user: { login: "reviewer" },
          body: "inline finding",
          path: "src/index.ts",
          line: 12,
          commit_id: SHA,
          created_at: "2026-07-20T00:00:00Z",
          html_url: "https://example.test/comment/20",
        }]],
      },
    ]);

    await expect(readGitHubReviewState(reviewContext, {
      owner: "GrowthX-Club",
      repo: "gx-backend",
      prNumber: 123,
    }, runner)).resolves.toMatchObject({
      ok: true,
      headSha: SHA,
      reviewCount: 1,
      inlineCommentCount: 1,
      reviewIdFilter: null,
      reviews: [{ author: "reviewer", body: "review body" }],
      inlineComments: [{
        author: "reviewer",
        body: "inline finding",
        path: "src/index.ts",
        line: 12,
      }],
    });

    expect(calls).toEqual([
      {
        method: "GET",
        endpoint: "repos/GrowthX-Club/gx-backend/pulls/123",
      },
      {
        method: "GET",
        endpoint: "repos/GrowthX-Club/gx-backend/pulls/123/reviews?per_page=100",
        paginate: true,
      },
      {
        method: "GET",
        endpoint: "repos/GrowthX-Club/gx-backend/pulls/123/comments?per_page=100",
        paginate: true,
      },
    ]);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("can verify comments for one exact review id", async () => {
    const { runner, calls } = scriptedRunner([
      { body: { head: { sha: SHA } } },
      { body: [[]] },
      { body: [[{ id: 20 }]] },
    ]);

    await expect(readGitHubReviewState(reviewContext, {
      owner: "GrowthX-Club",
      repo: "gx-backend",
      prNumber: 123,
      reviewId: 99,
    }, runner)).resolves.toMatchObject({
      ok: true,
      reviewIdFilter: 99,
      inlineCommentCount: 1,
    });
    expect(calls[2]?.endpoint).toBe(
      "repos/GrowthX-Club/gx-backend/pulls/123/reviews/99/comments?per_page=100",
    );
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("fails closed for unsigned, unauthorized, and invalid targets", async () => {
    const never: GitHubApiRunner = async () => {
      throw new Error("API should not be called");
    };
    const target = {
      owner: "GrowthX-Club",
      repo: "gx-backend",
      prNumber: 123,
    };

    await expect(readGitHubReviewState(
      { ...reviewContext, signed: false },
      target,
      never,
    )).resolves.toEqual({ ok: false, reason: "signed MCP run context required" });
    await expect(readGitHubReviewState(
      { ...reviewContext, agent: "reproducer" },
      target,
      never,
    )).resolves.toMatchObject({ ok: false });
    await expect(readGitHubReviewState(
      reviewContext,
      { ...target, repo: "gx-backend --method POST" },
      never,
    )).resolves.toEqual({ ok: false, reason: "invalid GitHub repository" });
    await expect(readGitHubReviewState(
      reviewContext,
      { ...target, reviewId: -1 },
      never,
    )).resolves.toEqual({ ok: false, reason: "reviewId must be a positive integer" });
  });
});
