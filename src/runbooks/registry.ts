import { readdir } from "fs/promises";
import { log } from "../logger.ts";
import { loadRunbookDefinition } from "./loader.ts";
import type { RunbookDefinition } from "./types.ts";

const PRIVATE_RUNBOOKS_DIR = "agents-org/runbooks";
const PUBLIC_RUNBOOKS_DIR = "runbooks";

const registry = new Map<string, RunbookDefinition>();

export async function reloadRunbookRegistry(): Promise<{
  loaded: number;
  errors: number;
}> {
  let loaded = 0;
  let errors = 0;

  for (const dir of [
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
        registry.set(result.definition.name, result.definition);
        loaded++;
      } else {
        // Last-known-good: don't replace a valid entry with a broken reload
        if (!registry.has(result.filePath)) {
          log.warn(
            "runbooks",
            `failed to load ${filePath}: ${result.errors.map((e) => e.message).join("; ")}`,
          );
        }
        errors++;
      }
    }
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
  let loaded = 0;
  let errors = 0;
  const files = await runbookFiles(dirPath);

  for (const file of files) {
    const filePath = `${dirPath}/${file}`;
    const result = await loadRunbookDefinition(filePath, {
      origin,
      filenameForValidation: file.replace(/\.runbook\.md$/, ""),
    });

    if (result.ok) {
      registry.set(result.definition.name, result.definition);
      loaded++;
    } else {
      if (!registry.has(result.filePath)) {
        log.warn(
          "runbooks",
          `failed to load ${filePath}: ${result.errors.map((e) => e.message).join("; ")}`,
        );
      }
      errors++;
    }
  }

  return { loaded, errors };
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
