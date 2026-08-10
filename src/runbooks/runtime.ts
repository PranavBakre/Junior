import { log } from "../logger.ts";
import type { CatalogStore } from "./catalog-store.ts";
import {
  listRunbooks,
  reloadRunbookRegistry,
  type RunbookRegistrySource,
} from "./registry.ts";

export interface RunbookRuntimeBootstrapOptions {
  sources?: RunbookRegistrySource[];
  privateCommitSha?: string;
  publicCommitSha?: string;
}

export interface RunbookRuntimeBootstrapResult {
  loaded: number;
  errors: number;
  activated: number;
  deactivated: number;
}

export function resolveGitCommitSha(cwd: string): string {
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    return proc.exitCode === 0 ? proc.stdout.toString().trim() : "";
  } catch {
    return "";
  }
}

/**
 * Load the Git-pinned runbook files and project the live registry into the
 * durable catalogue. This is the production activation boundary: definitions
 * are usable only when they are present in one of the reviewed source roots.
 */
export async function bootstrapRunbookRuntime(
  store: CatalogStore,
  options: RunbookRuntimeBootstrapOptions = {},
): Promise<RunbookRuntimeBootstrapResult> {
  const reload = await reloadRunbookRegistry({ sources: options.sources });
  const definitions = listRunbooks();
  const activeNames = new Set<string>();

  for (const definition of definitions) {
    activeNames.add(definition.name);
    store.upsertCatalogEntry({
      kind: "runbook",
      name: definition.name,
      repo: definition.origin === "private"
        ? "junior-private-agents"
        : "junior",
      path: definition.filePath,
      commitSha: definition.origin === "private"
        ? options.privateCommitSha ?? ""
        : options.publicCommitSha ?? "",
      contentDigest: definition.contentDigest,
      schemaVersion: definition.schemaVersion,
      enabled: true,
      loadedAt: Date.now(),
      validationStatus: "valid",
      validationErrors: null,
    });
  }

  let deactivated = 0;
  for (const entry of store.listCatalogEntries("runbook")) {
    if (entry.enabled && !activeNames.has(entry.name)) {
      if (store.deactivateEntry("runbook", entry.name)) deactivated++;
    }
  }

  const result = {
    ...reload,
    activated: definitions.length,
    deactivated,
  };
  log.info(
    "runbooks",
    `runtime bootstrap: ${result.activated} activated, ${result.deactivated} deactivated, ${result.errors} errors`,
  );
  return result;
}
