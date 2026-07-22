import { describe, expect, it } from "bun:test";
import { createGitHubClient, parsePullRequestNode } from "./client.ts";
import type { GraphQlPullRequestNode } from "./queries.ts";

describe("parsePullRequestNode", () => {
  it("parses a GraphQL PR node into a snapshot", () => {
    const node: GraphQlPullRequestNode = {
      id: "PR_kwDOA",
      number: 12,
      state: "OPEN",
      isDraft: false,
      merged: false,
      mergedAt: null,
      closedAt: null,
      updatedAt: "2026-01-01T00:00:00Z",
      baseRefName: "main",
      headRefName: "feat",
      headRefOid: "deadbeef",
      reviewDecision: "APPROVED",
      mergeable: "MERGEABLE",
      commits: {
        nodes: [
          {
            commit: {
              oid: "deadbeef",
              statusCheckRollup: { state: "SUCCESS" },
            },
          },
        ],
      },
    };
    const parsed = parsePullRequestNode(node);
    expect(parsed?.nodeId).toBe("PR_kwDOA");
    expect(parsed?.snapshot).toMatchObject({
      state: "OPEN",
      headRefOid: "deadbeef",
      reviewDecision: "APPROVED",
      checkRollup: "SUCCESS",
      checkRollupSha: "deadbeef",
    });
  });

  it("treats merged=true as MERGED even when state is CLOSED", () => {
    const parsed = parsePullRequestNode({
      id: "PR_1",
      number: 1,
      state: "CLOSED",
      merged: true,
      mergedAt: "t",
      baseRefName: "main",
      headRefOid: "abc",
    });
    expect(parsed?.snapshot.state).toBe("MERGED");
  });

  it("returns null for incomplete nodes", () => {
    expect(parsePullRequestNode({ id: "x", number: 1 })).toBeNull();
  });
});

describe("createGitHubClient", () => {
  it("requires token or CLI fallback", () => {
    expect(() => createGitHubClient({})).toThrow("GITHUB_RECONCILE_TOKEN");
  });

  it("fetches a PR via GraphQL", async () => {
    const client = createGitHubClient({
      token: "test-token",
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as {
          variables: { owner: string; repo: string; number: number };
        };
        expect(body.variables).toEqual({
          owner: "acme",
          repo: "widgets",
          number: 7,
        });
        return new Response(
          JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  id: "PR_7",
                  number: 7,
                  state: "OPEN",
                  isDraft: false,
                  merged: false,
                  baseRefName: "main",
                  headRefName: "f",
                  headRefOid: "sha7",
                  reviewDecision: null,
                  mergeable: "MERGEABLE",
                  commits: {
                    nodes: [
                      {
                        commit: {
                          oid: "sha7",
                          statusCheckRollup: { state: "PENDING" },
                        },
                      },
                    ],
                  },
                },
              },
              rateLimit: { remaining: 4999 },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    });

    const result = await client.fetchPullRequest("acme", "widgets", 7);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nodeId).toBe("PR_7");
      expect(result.snapshot.headRefOid).toBe("sha7");
    }
  });

  it("maps 401 to invalidCredentials", async () => {
    const client = createGitHubClient({
      token: "bad",
      fetchImpl: async () =>
        new Response("Bad credentials", {
          status: 401,
          headers: { "Content-Type": "text/plain" },
        }),
    });
    const result = await client.fetchPullRequest("a", "b", 1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.invalidCredentials).toBe(true);
    }
  });

  it("maps 429 to rateLimited with Retry-After", async () => {
    const client = createGitHubClient({
      token: "tok",
      fetchImpl: async () =>
        new Response("rate limit", {
          status: 429,
          headers: {
            "Retry-After": "12",
            "X-RateLimit-Remaining": "0",
          },
        }),
    });
    const result = await client.fetchPullRequest("a", "b", 1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rateLimited).toBe(true);
      expect(result.retryAfterMs).toBe(12_000);
    }
  });

  it("escalates ambiguous head-ref drift discovery", async () => {
    const client = createGitHubClient({
      token: "tok",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            data: {
              repository: {
                pullRequests: {
                  nodes: [
                    { number: 1, url: "u1", id: "PR_1" },
                    { number: 2, url: "u2", id: "PR_2" },
                  ],
                },
              },
            },
          }),
          { status: 200 },
        ),
    });
    const result = await client.findOpenPrForHeadRef("a", "b", "branch");
    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") {
      expect(result.candidates).toHaveLength(2);
    }
  });

  it("batches nodes(ids) responses", async () => {
    const client = createGitHubClient({
      token: "tok",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            data: {
              nodes: [
                {
                  id: "PR_1",
                  number: 1,
                  state: "OPEN",
                  baseRefName: "main",
                  headRefOid: "s1",
                  commits: { nodes: [] },
                },
                null,
              ],
              rateLimit: { remaining: 10 },
            },
          }),
          { status: 200 },
        ),
    });
    const map = await client.fetchPullRequestsByNodeIds(["PR_1", "PR_missing"]);
    expect(map.get("PR_1")?.ok).toBe(true);
    expect(map.get("PR_missing")?.ok).toBe(false);
  });

  it("passes CLI GraphQL arrays as repeated typed fields", async () => {
    let cliArgs: string[] = [];
    const client = createGitHubClient({
      useCli: true,
      runCli: async (args) => {
        cliArgs = args;
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({ data: { nodes: [null, null] } }),
          headers: {},
        };
      },
    });

    await client.fetchPullRequestsByNodeIds(["PR_1", "PR_2"]);

    expect(cliArgs).toContain("ids[]=PR_1");
    expect(cliArgs).toContain("ids[]=PR_2");
    expect(cliArgs).not.toContain('ids=["PR_1","PR_2"]');
  });
});
