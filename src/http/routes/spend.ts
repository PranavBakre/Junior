import { USAGE_RETENTION_MS } from "../../lifecycle/cleanup.ts";
import type { UsageGroupBy, UsageStore } from "../../usage/store/interface.ts";
import { parseTimeBound, startOfLocalDay } from "../query.ts";

const GROUP_BY = new Set<UsageGroupBy>([
  "day",
  "session",
  "agent",
  "provider",
  "workflow",
  "pipeline",
]);

export async function handleSpend(
  store: UsageStore,
  params: URLSearchParams,
): Promise<Response> {
  const parsedFrom = parseTimeBound(params.get("from"), "start");
  const parsedTo = parseTimeBound(params.get("to"), "end");
  if (!parsedFrom.ok) {
    return Response.json({ error: "invalid from" }, { status: 400 });
  }
  if (!parsedTo.ok) {
    return Response.json({ error: "invalid to" }, { status: 400 });
  }

  const from = parsedFrom.value ?? startOfLocalDay();
  const to = parsedTo.value ?? Date.now();
  if (from > to) {
    return Response.json({ error: "invalid range" }, { status: 400 });
  }
  if (to - from > USAGE_RETENTION_MS) {
    return Response.json({ error: "range exceeds retention" }, { status: 400 });
  }

  const rawGroupBy = params.get("groupBy") ?? "day";
  if (!GROUP_BY.has(rawGroupBy as UsageGroupBy)) {
    return Response.json({ error: "invalid groupBy" }, { status: 400 });
  }
  const groupBy = rawGroupBy as UsageGroupBy;
  const grouped = await store.groupBy({ from, to, groupBy });

  return Response.json({
    from,
    to,
    totals: grouped.totals,
    buckets: grouped.buckets,
  });
}
