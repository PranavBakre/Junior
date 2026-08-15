import type { CatalogStore } from "../../runbooks/catalog-store.ts";
import { computeMetrics } from "../../runbooks/metrics.ts";
import { getRunbook, searchRunbooks } from "../../runbooks/registry.ts";
import { parseLimit } from "../query.ts";

export async function handleRunbooks(
  params: URLSearchParams,
  catalog?: CatalogStore,
): Promise<Response> {
  const query = params.get("query") || undefined;
  const ownerAgent = params.get("ownerAgent") || undefined;
  const risk = params.get("risk") || undefined;
  const tag = params.get("tag") || undefined;
  const limit = parseLimit(params.get("limit"), 25, 100);

  const hits = searchRunbooks({
    query,
    ownerAgent,
    risk,
    tags: tag ? [tag] : undefined,
    limit,
  });

  const catalogByName = new Map(
    (catalog?.listCatalogEntries("runbook") ?? []).map((entry) => [entry.name, entry]),
  );

  const runbooks = hits.map((hit) => {
    const definition = getRunbook(hit.name);
    const entry = catalogByName.get(hit.name);
    const metrics = catalog
      ? computeMetrics(catalog.getRunsByName(hit.name))
      : null;
    return {
      name: hit.name,
      description: hit.description,
      ownerAgent: hit.ownerAgent,
      risk: hit.risk,
      tags: hit.tags,
      origin: hit.origin,
      contentDigest: hit.contentDigest,
      filePath: definition?.filePath ?? null,
      catalog: entry
        ? {
            repo: entry.repo,
            commitSha: entry.commitSha,
            validationStatus: entry.validationStatus,
            loadedAt: entry.loadedAt,
            enabled: entry.enabled,
          }
        : undefined,
      metrics,
    };
  });

  return Response.json({ runbooks, errors: [] });
}

export async function handleRunbookDetail(
  name: string,
  catalog?: CatalogStore,
): Promise<Response> {
  const runbook = getRunbook(name);
  if (!runbook) {
    return Response.json({ error: "runbook not found" }, { status: 404 });
  }

  const entry = catalog?.getCatalogEntry("runbook", name) ?? null;
  const metrics = catalog ? computeMetrics(catalog.getRunsByName(name)) : null;

  return Response.json({
    runbook,
    catalog: entry,
    metrics,
    git: {
      repo: entry?.repo ?? runbook.origin,
      path: entry?.path ?? runbook.filePath,
      commitSha: entry?.commitSha ?? "",
      contentDigest: entry?.contentDigest ?? runbook.contentDigest,
    },
  });
}
