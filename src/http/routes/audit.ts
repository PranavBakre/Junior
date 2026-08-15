import type { DashboardAuditStore } from "../audit/interface.ts";
import { parseLimit, parseTimeBound } from "../query.ts";

export async function handleAudit(
  store: DashboardAuditStore,
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

  const audit = await store.list({
    action: params.get("action") || undefined,
    targetType: params.get("targetType") || undefined,
    from: parsedFrom.value,
    to: parsedTo.value,
    limit: parseLimit(params.get("limit"), 100, 500),
  });

  return Response.json({ audit });
}
