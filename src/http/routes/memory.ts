/**
 * Junior doesn't have a `memory/` directory like Friday — its long-form context
 * lives under `docs/`. We expose the docs tree at `/api/memory` for parity with
 * Friday's dashboard so operators can browse architecture / feature notes from
 * the dashboard UI.
 */
import path from "node:path";
import type { MemoryStore } from "../../memory/store.ts";

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
  const results = await store.recall({
    query: params.get("query") ?? undefined,
    tags: csv(params.get("tags")),
    entities: csv(params.get("entities")),
    kinds: csv(params.get("kinds")) as Parameters<MemoryStore["recall"]>[0]["kinds"],
    limit: numberParam(params.get("limit")),
    depth: numberParam(params.get("depth")),
    includeInactive: params.get("includeInactive") === "true",
    includeInvalid: params.get("includeInvalid") === "true",
    // Operator browsing the dashboard is inspection, not real recall traffic:
    // don't bump use_count or pollute the replay log.
    recordUsage: false,
  });
  return Response.json({ results });
}

export async function handleMemoryConsolidate(store: MemoryStore): Promise<Response> {
  const result = await store.consolidate();
  return Response.json(result);
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
