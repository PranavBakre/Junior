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
| Review comments | `src/github/review-comments.ts` | Scopes comments to an exact head SHA and avoids duplicate writes. |
| Types | `src/github/types.ts` | GitHub resource, review, and reconciliation contracts. |

## Configuration

`GITHUB_RECONCILE_TOKEN`, `GITHUB_RECONCILE_INTERVAL_MS`,
`GITHUB_RECONCILE_USE_CLI`, and the event-wake flag are documented in
[`.env.example](../../.env.example). Event wake requires reconciliation to be
enabled. MCP review tools are limited to the fixed read-state and idempotent
comment operations; arbitrary GitHub mutation is not part of the contract.

The pipeline layer consumes reconciled state through typed resources and
outcomes. Failures are recoverable and must not be treated as proof that the
external review state changed.
