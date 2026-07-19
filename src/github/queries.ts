/**
 * GraphQL query strings for read-only GitHub PR reconciliation.
 * Prefer `nodes(ids: ...)` batching when node IDs are known.
 */

/** Fields shared by single-PR and batch node queries. */
export const PULL_REQUEST_SNAPSHOT_FIELDS = `
  id
  number
  state
  isDraft
  merged
  mergedAt
  closedAt
  updatedAt
  baseRefName
  headRefName
  headRefOid
  reviewDecision
  mergeable
  commits(last: 1) {
    nodes {
      commit {
        oid
        statusCheckRollup {
          state
        }
      }
    }
  }
`;

/**
 * Batch-fetch pull requests (and other nodes) by GraphQL node ID.
 * Non-PR nodes are ignored by the parser.
 */
export const NODES_PULL_REQUESTS_QUERY = `
  query JuniorReconcileNodes($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on PullRequest {
        ${PULL_REQUEST_SNAPSHOT_FIELDS}
        repository {
          name
          owner {
            login
          }
        }
      }
    }
    rateLimit {
      cost
      remaining
      resetAt
    }
  }
`;

/** Single PR by owner/name/number — used when node_id is not yet known. */
export const PULL_REQUEST_BY_NUMBER_QUERY = `
  query JuniorReconcilePr($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        ${PULL_REQUEST_SNAPSHOT_FIELDS}
      }
    }
    rateLimit {
      cost
      remaining
      resetAt
    }
  }
`;

/**
 * Drift-repair only: list open PRs for a head branch. Ambiguous results
 * must escalate — never pick the newest PR silently.
 */
export const OPEN_PRS_FOR_HEAD_REF_QUERY = `
  query JuniorDriftOpenPrs($owner: String!, $repo: String!, $headRef: String!) {
    repository(owner: $owner, name: $repo) {
      pullRequests(first: 10, states: OPEN, headRefName: $headRef) {
        nodes {
          number
          url
          id
          headRefOid
        }
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Response shapes (narrow, parser-facing)
// ---------------------------------------------------------------------------

export type GraphQlRateLimit = {
  cost?: number;
  remaining?: number;
  resetAt?: string;
};

export type GraphQlCommitNode = {
  commit?: {
    oid?: string;
    statusCheckRollup?: { state?: string | null } | null;
  } | null;
};

export type GraphQlPullRequestNode = {
  id?: string;
  number?: number;
  state?: string;
  isDraft?: boolean;
  merged?: boolean;
  mergedAt?: string | null;
  closedAt?: string | null;
  updatedAt?: string | null;
  baseRefName?: string;
  headRefName?: string;
  headRefOid?: string;
  reviewDecision?: string | null;
  mergeable?: string | null;
  commits?: { nodes?: Array<GraphQlCommitNode | null> | null } | null;
  repository?: {
    name?: string;
    owner?: { login?: string };
  } | null;
};

export type NodesQueryResponse = {
  data?: {
    nodes?: Array<GraphQlPullRequestNode | null>;
    rateLimit?: GraphQlRateLimit;
  };
  errors?: Array<{ message?: string; type?: string }>;
};

export type PullRequestByNumberResponse = {
  data?: {
    repository?: {
      pullRequest?: GraphQlPullRequestNode | null;
    } | null;
    rateLimit?: GraphQlRateLimit;
  };
  errors?: Array<{ message?: string; type?: string }>;
};

export type OpenPrsForHeadRefResponse = {
  data?: {
    repository?: {
      pullRequests?: {
        nodes?: Array<{
          number?: number;
          url?: string;
          id?: string;
          headRefOid?: string;
        } | null> | null;
      } | null;
    } | null;
  };
  errors?: Array<{ message?: string; type?: string }>;
};
