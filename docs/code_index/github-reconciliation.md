# Code Index: GitHub Reconciliation

GitHub integration is an outbound read/reconcile surface. It is optional and
disabled unless `GITHUB_RECONCILE_ENABLED=true`; it does not require an inbound
webhook to keep pipeline state correct.

## Sources

| Symbol/area | File | Purpose |
|---|---|---|
| GitHub client | `src/github/client.ts` | Authenticated, bounded GitHub API operations. |
| Query builders | `src/github/queries.ts` | Resource/review queries used by reconciliation. |
| `reconcile*` | `src/github/reconciler.ts` | Fetches external state and applies idempotent internal updates. |
| Diffing | `src/github/diff.ts` | Compares observed and projected review/resource state. |
| Merge-prune trigger | `src/github/prune-trigger.ts` | Extracts exact merged PR repo/branch targets for scoped worktree pruning. |
| Review comments | `src/github/review-comments.ts` | Scopes comments to an exact head SHA and avoids duplicate writes. |
| Types | `src/github/types.ts` | GitHub resource, review, and reconciliation contracts. |
| Repo-scoped auth | `src/github/auth.ts`, `src/config.ts` | Resolves each configured `RepoConfig.githubUser` with `gh auth token --user`, verifies the account with `gh api user`, and injects only that token plus an isolated `GH_CONFIG_DIR` into repo-scoped `gh` children. Unknown repo mappings and repos without `githubUser` are rejected before `gh` runs. |
| Bounded CLI transport | `src/github/cli.ts` | Concurrently drains `gh` stdout/stderr with 512 KiB response and 64 KiB diagnostic caps, hard timeout, and process-group cleanup. |

## Configuration

`GITHUB_RECONCILE_TOKEN`, `GITHUB_RECONCILE_INTERVAL_MS`,
`GITHUB_RECONCILE_USE_CLI`, and the event-wake flag are documented in
[`.env.example](../../.env.example). Event wake requires reconciliation to be
enabled. MCP review tools are limited to the fixed read-state and idempotent
comment operations; arbitrary GitHub mutation is not part of the contract.

The pipeline layer consumes reconciled state through typed resources and
outcomes. Failures are recoverable and must not be treated as proof that the
external review state changed.

CLI fallback is development-only and is identity-bound: requests without an
exact `owner/repo` mapping (including node-ID-only queries) fail closed rather
than using the host's active `gh` account. The normal HTTP reconciler remains
available with its explicit `GITHUB_RECONCILE_TOKEN`; it does not use `gh`.
Runner environments use empty token sentinels plus an isolated config directory
unless the selected target repo supplied a verified auth environment.

The review-state reader no longer delegates unbounded pagination to `gh`.
It requests up to ten `per_page=100` pages sequentially, rejects a response
that exceeds 512 KiB in aggregate, and preserves the existing slurped-array
parser contract for callers.

When a reconcile pass observes an `OPEN`/`CLOSED` to `MERGED` transition,
Junior starts `worktree-prune` with structured trigger context containing the
PR coordinates, head branch, and head SHA. The event-triggered prune inspects
only those exact worktrees and retains every normal prune safety gate. The
workflow runs asynchronously so a long cleanup cannot block GitHub polling;
its dispatcher coalesces newly merged branches and retries an overlap skip, so
the workflow's `concurrency: skip` policy prevents overlap without losing a
merge-triggered cleanup. Thrown runs are requeued with bounded exponential
backoff. Repo selection is enforced by an exact case-insensitive comparison of
the event's `owner/repo` with configured `RepoConfig.githubRepo`; local aliases
and same-named forks cannot satisfy the match.
