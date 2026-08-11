import { readdir } from "fs/promises";
import { log } from "../logger.ts";
import { loadRunbookDefinition } from "./loader.ts";
import type { RunbookDefinition } from "./types.ts";

const PRIVATE_RUNBOOKS_DIR = "agents-org/runbooks";
const PUBLIC_RUNBOOKS_DIR = "runbooks";

const registry = new Map<string, RunbookDefinition>();

export interface RunbookRegistrySource {
  path: string;
  origin: "private" | "public";
}

export async function reloadRunbookRegistry(options?: {
  sources?: RunbookRegistrySource[];
}): Promise<{
  loaded: number;
  errors: number;
}> {
  let loaded = 0;
  let errors = 0;
  const nextRegistry = new Map<string, RunbookDefinition>();

  for (const dir of options?.sources ?? [
    { path: PRIVATE_RUNBOOKS_DIR, origin: "private" as const },
    { path: PUBLIC_RUNBOOKS_DIR, origin: "public" as const },
  ]) {
    const files = await runbookFiles(dir.path);
    for (const file of files) {
      const filePath = `${dir.path}/${file}`;
      const result = await loadRunbookDefinition(filePath, {
        origin: dir.origin,
        filenameForValidation: file.replace(/\.runbook\.md$/, ""),
      });

      if (result.ok) {
        nextRegistry.set(result.definition.name, result.definition);
        loaded++;
      } else {
        // Preserve last-known-good only while the same pinned source file is
        // still present. Definitions removed from all roots must disappear.
        const expectedName = file.replace(/\.runbook\.md$/, "");
        const prior = registry.get(expectedName);
        if (
          !nextRegistry.has(expectedName) &&
          prior?.filePath === filePath &&
          prior.origin === dir.origin
        ) {
          nextRegistry.set(expectedName, prior);
        } else if (!nextRegistry.has(expectedName)) {
          log.warn(
            "runbooks",
            `failed to load ${filePath}: ${result.errors.map((e) => e.message).join("; ")}`,
          );
        }
        errors++;
      }
    }
  }

  registry.clear();
  for (const [name, definition] of nextRegistry) {
    registry.set(name, definition);
  }

  log.info("runbooks", `registry reload: ${loaded} loaded, ${errors} errors`);
  return { loaded, errors };
}

export function getRunbook(name: string): RunbookDefinition | undefined {
  return registry.get(name);
}

export function getContentDigest(name: string): string | undefined {
  return registry.get(name)?.contentDigest;
}

export function listRunbooks(): RunbookDefinition[] {
  return [...registry.values()];
}

export interface RunbookSearchOptions {
  query?: string;
  tags?: string[];
  ownerAgent?: string;
  risk?: string;
  limit?: number;
}

export interface RunbookSearchResult {
  name: string;
  description: string;
  ownerAgent: string;
  risk: string;
  tags: string[];
  origin: "private" | "public";
  contentDigest: string;
}

export function searchRunbooks(
  options: RunbookSearchOptions,
): RunbookSearchResult[] {
  const query = options.query?.trim().toLowerCase();
  const limit = Math.min(options.limit ?? 25, 100);
  const results: RunbookSearchResult[] = [];

  for (const def of registry.values()) {
    if (query) {
      const haystack =
        `${def.name} ${def.description} ${def.tags.join(" ")}`.toLowerCase();
      if (!haystack.includes(query)) continue;
    }
    if (options.tags && options.tags.length > 0) {
      const defTags = new Set(def.tags);
      if (!options.tags.some((t) => defTags.has(t))) continue;
    }
    if (options.ownerAgent && def.ownerAgent !== options.ownerAgent) continue;
    if (options.risk && def.risk !== options.risk) continue;

    results.push({
      name: def.name,
      description: def.description,
      ownerAgent: def.ownerAgent,
      risk: def.risk,
      tags: def.tags,
      origin: def.origin,
      contentDigest: def.contentDigest,
    });

    if (results.length >= limit) break;
  }

  return results;
}

export function clearRegistryForTests(): void {
  registry.clear();
}

export async function loadRunbookRegistryFromDir(
  dirPath: string,
  origin: "private" | "public",
): Promise<{ loaded: number; errors: number }> {
  return reloadRunbookRegistry({ sources: [{ path: dirPath, origin }] });
}

async function runbookFiles(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".runbook.md"))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}
