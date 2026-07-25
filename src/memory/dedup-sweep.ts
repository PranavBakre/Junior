/**
 * Offline backfill sweep for claim near-duplicates
 * (docs/features/claim-dedup-write-guard.md §Backfill).
 *
 * The write guard in `upsertClaim` stops NEW duplicates. It does nothing about
 * the ones already in the corpus, which arrived through the three writers that
 * used to bypass the consolidation-only gate. This sweep collapses them.
 *
 * Like `migrate-v3.ts`, it is a DRY RUN by default: it clusters, picks
 * survivors, and reports exactly what it would do, but mutates nothing until
 * `apply: true`. And like the decay contract, it ARCHIVES (`active = 0`) rather
 * than deleting — the collapsed rows stay as provenance for the merge.
 */
import { compareDedupWinner, dedupScopeKey, resolveDedupThreshold } from "./dedup.ts";
import type { MemoryStore } from "./store.ts";
import type { ClaimKind, ClaimVectorExport } from "./types.ts";

export interface DedupSweepOptions {
  store: MemoryStore;
  /** Cosine at/above which two claims collapse. Defaults to MEMORY_DEDUP_THRESHOLD / 0.92. */
  threshold?: number;
  /**
   * Destructive switch. `false` (the default) reports what WOULD collapse and
   * writes nothing. `true` folds counters into each survivor and archives the
   * duplicates.
   */
  apply?: boolean;
}

/** One collapsed cluster: the survivor plus the claims folded into it. */
export interface DedupSweepCluster {
  kind: ClaimKind;
  repo: string | null;
  survivorId: string;
  survivorText: string;
  duplicateIds: string[];
  /** Highest cosine seen between the survivor and any duplicate — audit signal. */
  maxCosine: number;
}

export interface DedupSweepReport {
  /** Whether the destructive path ran. */
  applied: boolean;
  threshold: number;
  /** Active claims carrying an embedding that the sweep considered. */
  claimsScanned: number;
  /** Clusters with at least one duplicate. */
  clusters: number;
  /** Duplicates found across all clusters (reported on a dry run too). */
  duplicatesFound: number;
  /** Duplicates actually flipped to `active = 0`. Always 0 on a dry run. */
  duplicatesArchived: number;
  /** Per-cluster detail, ordered by survivor id for reproducible output. */
  clusterDetail: DedupSweepCluster[];
}

export async function runDedupSweep(options: DedupSweepOptions): Promise<DedupSweepReport> {
  const threshold = options.threshold ?? resolveDedupThreshold();
  const apply = options.apply === true;

  // exportClaimVectors already returns only ACTIVE claims that carry a vector —
  // exactly the sweep's candidate set. Claims with no embedding are invisible to
  // cosine and cannot be clustered.
  const claims = await options.store.exportClaimVectors();

  const scopes = new Map<string, ClaimVectorExport[]>();
  for (const claim of claims) {
    const key = dedupScopeKey(claim.kind, claim.repo);
    const bucket = scopes.get(key);
    if (bucket) bucket.push(claim);
    else scopes.set(key, [claim]);
  }

  const clusterDetail: DedupSweepCluster[] = [];
  for (const members of scopes.values()) {
    clusterDetail.push(...clusterScope(members, threshold));
  }
  clusterDetail.sort((a, b) => (a.survivorId < b.survivorId ? -1 : a.survivorId > b.survivorId ? 1 : 0));

  const duplicatesFound = clusterDetail.reduce((n, c) => n + c.duplicateIds.length, 0);

  let duplicatesArchived = 0;
  if (apply) {
    for (const cluster of clusterDetail) {
      const result = await options.store.collapseDuplicateClaims({
        survivorId: cluster.survivorId,
        duplicateIds: cluster.duplicateIds,
      });
      duplicatesArchived += result.archivedIds.length;
    }
  }

  return {
    applied: apply,
    threshold,
    claimsScanned: claims.length,
    clusters: clusterDetail.length,
    duplicatesFound,
    duplicatesArchived,
    clusterDetail,
  };
}

/**
 * Cluster ONE dedup scope: walk the members in winner order and let each
 * unclaimed member absorb every remaining member within `threshold` OF ITSELF
 * (not transitively — a chain of 0.93 hops is not one claim).
 *
 * Sorting by the shared winner ordering first is what makes the representative
 * the same claim the write guard would have merged into; a sweep that picked
 * differently would keep fighting the guard. It also removes the dependence on
 * row order, so a re-run against the same corpus produces the same plan.
 */
function clusterScope(members: ClaimVectorExport[], threshold: number): DedupSweepCluster[] {
  const ordered = [...members].sort(compareDedupWinner);
  const taken = new Array<boolean>(ordered.length).fill(false);
  const clusters: DedupSweepCluster[] = [];

  for (let i = 0; i < ordered.length; i += 1) {
    if (taken[i]) continue;
    taken[i] = true;
    const survivor = ordered[i];
    const duplicateIds: string[] = [];
    let maxCosine = 0;
    for (let j = i + 1; j < ordered.length; j += 1) {
      if (taken[j]) continue;
      const sim = cosine(survivor.vector, ordered[j].vector);
      if (sim < threshold) continue;
      taken[j] = true;
      duplicateIds.push(ordered[j].id);
      if (sim > maxCosine) maxCosine = sim;
    }
    if (duplicateIds.length === 0) continue;
    clusters.push({
      kind: survivor.kind,
      repo: survivor.repo,
      survivorId: survivor.id,
      survivorText: survivor.text,
      duplicateIds,
      maxCosine,
    });
  }

  return clusters;
}

/** Cosine similarity. Returns 0 for mismatched dims or a zero vector. */
function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Compact, Slack-ready summary of a sweep run. */
export function formatDedupSweep(report: DedupSweepReport): string {
  const mode = report.applied ? "APPLIED" : "DRY RUN — nothing written";
  const lines = [
    `Claim dedup sweep (${mode}) @ cosine >= ${report.threshold}`,
    `  claims scanned: ${report.claimsScanned}`,
    `  clusters: ${report.clusters}`,
    `  duplicates found: ${report.duplicatesFound}`,
    `  duplicates archived: ${report.duplicatesArchived}`,
  ];
  for (const cluster of report.clusterDetail.slice(0, DEDUP_SWEEP_DETAIL_CAP)) {
    lines.push(
      `  - ${cluster.survivorId} (${cluster.kind}, repo ${cluster.repo ?? "global"}) ` +
        `absorbs ${cluster.duplicateIds.length} [max cos ${cluster.maxCosine.toFixed(4)}]`,
    );
  }
  if (report.clusterDetail.length > DEDUP_SWEEP_DETAIL_CAP) {
    lines.push(`  … ${report.clusterDetail.length - DEDUP_SWEEP_DETAIL_CAP} more clusters (use --json)`);
  }
  return `${lines.join("\n")}\n`;
}

/** Keep the human/Slack summary readable; `--json` carries the full detail. */
const DEDUP_SWEEP_DETAIL_CAP = 20;
