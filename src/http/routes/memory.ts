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
 * 2D projection of the claim embedding space for the "memory cloud" debug view.
 * PCA (top-2 components) + KNN edges (k=5, cosine) computed at render time from
 * the raw vectors — nothing here is stored. The projection distorts: local
 * neighbourhoods are meaningful, global distances are not. The 0–1 claim guard
 * lives in projectClaims().
 */
export async function handleMemoryProjection(store: MemoryStore): Promise<Response> {
  const claims = await store.exportClaimVectors();
  const { points, edges } = projectClaims(claims, 5);
  return Response.json({ points, edges });
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
