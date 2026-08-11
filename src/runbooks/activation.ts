import { log } from "../logger.ts";
import type { CatalogEntry, CatalogStore } from "./catalog-store.ts";
import { getRunbook, reloadRunbookRegistry } from "./registry.ts";

export type ActivationResult =
  | { ok: true; name: string; contentDigest: string; catalogEntry: CatalogEntry }
  | { ok: false; reason: string };

export async function activateDefinition(
  name: string,
  store: CatalogStore,
  options?: { commitSha?: string },
): Promise<ActivationResult> {
  await reloadRunbookRegistry();

  const def = getRunbook(name);
  if (!def) {
    return { ok: false, reason: `runbook "${name}" not found after reload` };
  }

  const entry: CatalogEntry = {
    kind: "runbook",
    name: def.name,
    repo: "junior-private-agents",
    path: def.filePath,
    commitSha: options?.commitSha ?? "",
    contentDigest: def.contentDigest,
    schemaVersion: def.schemaVersion,
    enabled: true,
    loadedAt: Date.now(),
    validationStatus: "valid",
    validationErrors: null,
  };

  store.upsertCatalogEntry(entry);
  log.info("runbooks", `activated ${name} (digest: ${def.contentDigest.slice(0, 16)})`);

  return {
    ok: true,
    name: def.name,
    contentDigest: def.contentDigest,
    catalogEntry: entry,
  };
}

export function deactivateDefinition(
  name: string,
  store: CatalogStore,
): boolean {
  const deactivated = store.deactivateEntry("runbook", name);
  if (deactivated) {
    log.info("runbooks", `deactivated ${name}`);
  }
  return deactivated;
}

export type SubmoduleUpdateResult =
  | { ok: true; oldSha: string; newSha: string }
  | { ok: false; reason: string };

export async function updateSubmodulePointer(
  options?: { dryRun?: boolean },
): Promise<SubmoduleUpdateResult> {
  const dryRun = options?.dryRun ?? true;

  try {
    const oldProc = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
      cwd: "agents-org",
      stdout: "pipe",
      stderr: "pipe",
    });
    const oldSha = oldProc.stdout?.toString().trim() ?? "unknown";

    if (dryRun) {
      return { ok: true, oldSha, newSha: "(dry-run)" };
    }

    const updateProc = Bun.spawnSync(
      ["git", "submodule", "update", "--remote", "agents-org"],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (updateProc.exitCode !== 0) {
      return {
        ok: false,
        reason: `submodule update failed: ${updateProc.stderr?.toString()}`,
      };
    }

    const newProc = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
      cwd: "agents-org",
      stdout: "pipe",
      stderr: "pipe",
    });
    const newSha = newProc.stdout?.toString().trim() ?? "unknown";

    return { ok: true, oldSha, newSha };
  } catch (err) {
    return {
      ok: false,
      reason: `submodule update error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
