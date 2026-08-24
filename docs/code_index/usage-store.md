# Code Index: Usage Store

Usage persistence and spend aggregation used by the dashboard and health
routes.

## Code Index

| Symbol | File | Purpose |
|---|---|---|
| `UsageStore` | `src/usage/store/interface.ts` | Provider-neutral add/get/list/group/count/thread-summary/retention contract. |
| `InMemoryUsageStore.groupBy` | `src/usage/store/memory.ts` | Reference aggregate behavior for tests and development. |
| `SqliteUsageStore.groupBy` | `src/usage/store/sqlite.ts` | Uses SQL `COUNT`, `SUM`, and `GROUP BY` over the bounded time window; only aggregate rows cross into JavaScript. |
| `groupUsageEvents` | `src/usage/store/aggregate.ts` | In-memory grouping semantics, including null labels, missing-usage turns, and locale-sorted buckets. |

`SqliteUsageStore.groupBy` keeps the response shape identical to the in-memory
provider. Group labels are allowlisted expressions for day, session, agent,
provider, workflow, and pipeline. Day grouping builds bounded SQL `CASE`
segments from the JavaScript runtime's historical timezone offsets, so DST
transitions are applied per event range rather than using today's offset.
Totals and buckets are aggregate queries, so a large usage table is not
materialized by the spend endpoint.
