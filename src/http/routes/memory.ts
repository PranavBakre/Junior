/**
 * Junior doesn't have a `memory/` directory like Friday — its long-form context
 * lives under `docs/`. We expose the docs tree at `/api/memory` for parity with
 * Friday's dashboard so operators can browse architecture / feature notes from
 * the dashboard UI.
 */
import path from "node:path";

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
