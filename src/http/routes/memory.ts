/**
 * Junior doesn't have a `memory/` directory like Friday — its long-form context
 * lives under `docs/`. We expose the docs tree at `/api/memory` for parity with
 * Friday's dashboard so operators can browse architecture / feature notes from
 * the dashboard UI.
 */
import path from "node:path";
import type { MemoryStore } from "../../memory/store.ts";
import type { ClaimKind } from "../../memory/types.ts";
import type { EmbeddingProviderKind } from "../../memory/embedding/factory.ts";
import { projectClaims } from "../projection.ts";

// The local embedding provider lazy-loads a ~500MB ONNX model on its first
// embed; build it once on the first dashboard recall, never at startup. Mirrors
// the lazy embedder seam in src/mcp/slack-server.ts.
let dashboardEmbedder: import("../../memory/embedding/types.ts").EmbeddingProvider | undefined;

async function getDashboardEmbedder(): Promise<
  import("../../memory/embedding/types.ts").EmbeddingProvider
> {
  if (!dashboardEmbedder) {
    const { createEmbeddingProvider } = await import("../../memory/embedding/factory.ts");
    const kind = (process.env.MEMORY_EMBED_PROVIDER as EmbeddingProviderKind | undefined) ?? "local";
    dashboardEmbedder = createEmbeddingProvider(kind);
  }
  return dashboardEmbedder;
}

const DOCS_DIR = path.resolve(import.meta.dir, "../../../docs");

export async function handleMemoryList(): Promise<Response> {
  const files: string[] = [];
  const glob = new Bun.Glob("**/*.md");

  try {
    for await (const entry of glob.scan({ cwd: DOCS_DIR })) {
      files.push(entry);
    }
  } catch {
    return Response.json({ files: [] });
  }

  files.sort();
  return Response.json({ files });
}

export async function handleMemoryRead(filePath: string): Promise<Response> {
  if (filePath.includes("..") || filePath.startsWith("/")) {
    return Response.json({ error: "invalid path" }, { status: 400 });
  }

  const fullPath = path.resolve(DOCS_DIR, filePath);
  if (!fullPath.startsWith(DOCS_DIR)) {
    return Response.json({ error: "invalid path" }, { status: 400 });
  }

  const file = Bun.file(fullPath);
  if (!(await file.exists())) {
    return Response.json({ error: "file not found" }, { status: 404 });
  }

  const content = await file.text();
  return Response.json({ path: filePath, content });
}

export async function handleMemoryRecall(
  store: MemoryStore,
  params: URLSearchParams,
): Promise<Response> {
  const query = params.get("query") ?? undefined;
  const kinds = csv(params.get("kinds")) as ClaimKind[] | undefined;
  // Embed the query at this boundary — recallClaims never embeds. Skipped when
  // no query is given (then recall ranks by weight under the filters).
  let queryVector: Float32Array | undefined;
  if (query && query.trim()) {
    const embedder = await getDashboardEmbedder();
    [queryVector] = await embedder.embed([query], "query");
  }
  const results = await store.recallClaims({
    queryVector,
    filters: {
      repo: params.get("repo") ?? undefined,
      // ClaimRecallFilters carries a single kind; use the first requested.
      kind: kinds && kinds.length > 0 ? kinds[0] : undefined,
      tags: csv(params.get("tags")),
    },
    limit: numberParam(params.get("limit")),
    // Operator browsing the dashboard is inspection, not real recall traffic:
    // don't bump last_used_at or pollute the fade signal.
    recordUsage: false,
  });
  return Response.json({ results });
}

/**
 * 3D projection of the claim embedding space for the "memory galaxy" view.
 * PCA (top-3 components) + a spread pass + KNN edges (k=5, cosine), all computed
 * at render time from the raw vectors — nothing here is stored. The projection
 * distorts: local neighbourhoods are meaningful, global distances are not. The
 * 0–1 claim guard lives in projectClaims().
 *
 * The compute is a few seconds on a multi-thousand-claim corpus (KNN is O(n²d)),
 * so the result is memoised against a signature of the claim set. Claims only
 * change on a consolidation write, so a stale-free cache is just "recompute when
 * the id set or count changes"; `?refresh=1` forces a rebuild regardless.
 */
let projectionCache: { signature: string; body: string } | null = null;

export async function handleMemoryProjection(
  store: MemoryStore,
  params?: URLSearchParams,
): Promise<Response> {
  const claims = await store.exportClaimVectors();
  const signature = claimSignature(claims);

  if (params?.get("refresh") !== "1" && projectionCache?.signature === signature) {
    return jsonBody(projectionCache.body, true);
  }

  const { points, edges } = projectClaims(claims, 5);
  const body = JSON.stringify({ points, edges, facets: buildFacets(points) });
  projectionCache = { signature, body };
  return jsonBody(body, false);
}

function jsonBody(body: string, cached: boolean): Response {
  return new Response(body, {
    headers: { "Content-Type": "application/json", "X-Projection-Cache": cached ? "hit" : "miss" },
  });
}

/**
 * Cheap order-independent fingerprint of the active claim set: count plus an
 * XOR-fold of per-id hashes. An edit that rewrites a claim's text without
 * changing ids won't bust it — acceptable for a debug view with a manual
 * `?refresh=1`, and far cheaper than hashing every 640-dim vector.
 */
function claimSignature(claims: Array<{ id: string }>): string {
  let fold = 0;
  for (const claim of claims) {
    let h = 2166136261;
    for (let i = 0; i < claim.id.length; i += 1) {
      h ^= claim.id.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    fold = (fold ^ h) >>> 0;
  }
  return `${claims.length}:${fold.toString(16)}`;
}

/** Tag / kind / repo counts so the UI can build filter chips without a scan. */
function buildFacets(points: Array<{ kind: string; tags: string[]; repo: string | null }>): {
  tags: Array<{ value: string; count: number }>;
  kinds: Array<{ value: string; count: number }>;
  repos: Array<{ value: string; count: number }>;
} {
  const tags = new Map<string, number>();
  const kinds = new Map<string, number>();
  const repos = new Map<string, number>();
  for (const point of points) {
    kinds.set(point.kind, (kinds.get(point.kind) ?? 0) + 1);
    if (point.repo) repos.set(point.repo, (repos.get(point.repo) ?? 0) + 1);
    for (const tag of point.tags) tags.set(tag, (tags.get(tag) ?? 0) + 1);
  }
  return { tags: sortFacet(tags), kinds: sortFacet(kinds), repos: sortFacet(repos) };
}

function sortFacet(counts: Map<string, number>): Array<{ value: string; count: number }> {
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

function csv(value: string | null): string[] | undefined {
  if (!value) return undefined;
  return value.split(",").map((part) => part.trim()).filter(Boolean);
}

function numberParam(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
