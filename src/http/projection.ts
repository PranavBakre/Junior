/**
 * 3D projection of the claim embedding space for the dashboard's "memory galaxy"
 * view. Everything here is computed AT RENDER TIME from the raw vectors and is
 * NOT stored — it is exploration, not a precise map.
 *
 * IMPORTANT CAVEAT (surfaced in the UI too): projecting a 640-dim space to 3D
 * preserves the directions of greatest variance, but it DISTORTS. Local
 * neighbourhoods (which points sit near which) are meaningful; absolute positions
 * and global distances are NOT. Two clusters far apart on screen may be close in
 * the full space, and vice-versa. Read the KNN edges, not the coordinates.
 *
 * Two stages, both dependency-free:
 *
 *  1. PCA to 3D. The top-3 principal components are found by matrix-free power
 *     iteration (the dominant eigenvector of the covariance, computed as Xᵀ(Xv)
 *     without ever materialising the 640×640 covariance matrix), then deflation
 *     for the second and third. For the claim corpus (low thousands of 640-dim
 *     vectors, per memory-system-v3.md §6.2) this is a sub-second compute.
 *
 *  2. A spread pass. Raw PCA alone packs thousands of claims into a dense blob —
 *     the top-3 components explain only a slice of a 640-dim corpus, so distinct
 *     topics land on top of each other and the core becomes an unreadable smear.
 *     `spreadLayout` fixes that VISUAL collapse without inventing structure: it
 *     pushes overlapping stars apart to a minimum separation while KNN edges act
 *     as springs holding true neighbours together. Both forces are short-range,
 *     so PCA's global arrangement survives. Fully deterministic — the same corpus
 *     always yields the same galaxy.
 *
 * Tried and rejected: a full UMAP SGD (attract along the KNN graph, repel by
 * negative sampling) on this corpus. Its cosine-weighted KNN edges are nearly
 * uniform in strength, so attraction dominated and 2.6k claims collapsed into two
 * pinpoint balls — worse convergence than the PCA blob it replaced.
 */

export interface ClaimVec {
  id: string;
  kind: string;
  text: string;
  tags: string[];
  vector: Float32Array;
  repo?: string | null;
  weight?: number;
  createdAt?: number;
  lastUsedAt?: number | null;
}

export interface ProjectionPoint {
  id: string;
  x: number;
  y: number;
  z: number;
  kind: string;
  text: string;
  tags: string[];
  repo: string | null;
  weight: number;
  createdAt: number | null;
  lastUsedAt: number | null;
}

export interface ProjectionEdge {
  a: string;
  b: string;
  sim: number;
}

export interface ProjectionResult {
  points: ProjectionPoint[];
  edges: ProjectionEdge[];
}

/** Layout knobs — exposed for tests, not for callers to tune per-request. */
export interface SpreadOptions {
  iterations: number;
  /**
   * Minimum star separation, as a multiple of the nominal uniform spacing
   * (`2 / ∛n` in the [-1,1] cube). This is the whole point of the pass: below it,
   * stars are pushed apart until they are individually visible.
   */
  minSepScale: number;
  /**
   * How far a KNN neighbour may drift before its spring pulls back, as a multiple
   * of the separation floor. Must stay > 1 or the springs fight the floor.
   */
  edgeSlack: number;
  /** Per-iteration step damping. Below 1 to avoid oscillation between the two forces. */
  damping: number;
}

const DEFAULT_SPREAD: SpreadOptions = {
  iterations: 80,
  // 0.55 is the empirical middle: high enough that the dense core stops being an
  // unclickable smear, low enough that PCA's lobes and the gaps between them
  // survive. Push it toward 1 and the corpus flattens into a uniform ball.
  minSepScale: 0.55,
  edgeSlack: 2.2,
  damping: 0.55,
};

/**
 * Project claims to 3D via PCA + spread, and compute KNN edges (cosine, k=5).
 * Guards the 0–1 claim case gracefully: points collapse to the origin and there
 * are no edges (the store may be near-empty pre-migration).
 *
 * Pass `spread: false` to get the raw PCA coordinates (used by tests that assert
 * on PCA structure itself).
 */
export function projectClaims(
  input: ClaimVec[],
  k = 5,
  spread: boolean | Partial<SpreadOptions> = true,
): ProjectionResult {
  // Guard a mixed-dim corpus (e.g. mid model-change rebuild, before re-embed):
  // PCA/KNN require a uniform dimension. Project the dominant (modal) dim only;
  // off-dim vectors are dropped from the cloud rather than producing NaN coords.
  const dimCounts = new Map<number, number>();
  for (const c of input) dimCounts.set(c.vector.length, (dimCounts.get(c.vector.length) ?? 0) + 1);
  let modalDim = 0;
  let best = -1;
  for (const [d, count] of dimCounts) if (count > best) { best = count; modalDim = d; }
  const claims = input.filter((c) => c.vector.length === modalDim);

  const n = claims.length;
  if (n <= 1) {
    return { points: claims.map((c) => toPoint(c, 0, 0, 0)), edges: [] };
  }

  const dim = modalDim;

  // Mean-center: PCA requires the data be centred on the origin.
  const mean = new Float64Array(dim);
  for (const c of claims) for (let i = 0; i < dim; i += 1) mean[i] += c.vector[i];
  for (let i = 0; i < dim; i += 1) mean[i] /= n;

  const centered: Float64Array[] = claims.map((c) => {
    const row = new Float64Array(dim);
    for (let i = 0; i < dim; i += 1) row[i] = c.vector[i] - mean[i];
    return row;
  });

  // Top-3 principal components by power iteration + deflation.
  const pc1 = powerIteration(centered, dim);
  deflate(centered, pc1);
  const pc2 = powerIteration(centered, dim);
  deflate(centered, pc2);
  const pc3 = powerIteration(centered, dim);

  // Project the ORIGINAL centred data (not the deflated residual) so each axis
  // carries the full variance along its component.
  const coords = new Float64Array(n * 3);
  for (let idx = 0; idx < n; idx += 1) {
    const v = claims[idx].vector;
    let x = 0;
    let y = 0;
    let z = 0;
    for (let i = 0; i < dim; i += 1) {
      const c = v[i] - mean[i];
      x += c * pc1[i];
      y += c * pc2[i];
      z += c * pc3[i];
    }
    coords[idx * 3] = x;
    coords[idx * 3 + 1] = y;
    coords[idx * 3 + 2] = z;
  }

  const edges = knnEdges(claims, k);

  normalizeToUnitCube(coords, n);
  if (spread !== false) {
    const index = new Map<string, number>();
    for (let i = 0; i < n; i += 1) index.set(claims[i].id, i);
    spreadLayout(coords, n, edges, index, {
      ...DEFAULT_SPREAD,
      ...(typeof spread === "object" ? spread : {}),
    });
    normalizeToUnitCube(coords, n);
  }

  const points = claims.map((c, i) =>
    toPoint(c, coords[i * 3], coords[i * 3 + 1], coords[i * 3 + 2]),
  );
  return { points, edges };
}

function toPoint(c: ClaimVec, x: number, y: number, z: number): ProjectionPoint {
  return {
    id: c.id,
    x,
    y,
    z,
    kind: c.kind,
    text: c.text,
    tags: c.tags,
    repo: c.repo ?? null,
    weight: typeof c.weight === "number" ? c.weight : 1,
    createdAt: c.createdAt ?? null,
    lastUsedAt: c.lastUsedAt ?? null,
  };
}

/**
 * Dominant eigenvector of the covariance of `rows` via matrix-free power
 * iteration: v ← Xᵀ(Xv), normalise, repeat. Deterministic seed so the same data
 * always yields the same projection (sign may flip, which is fine for a viz).
 */
function powerIteration(rows: Float64Array[], dim: number, iters = 100): Float64Array {
  let v = new Float64Array(dim);
  for (let i = 0; i < dim; i += 1) v[i] = Math.sin(i + 1); // deterministic seed
  normalizeInPlace(v);

  for (let it = 0; it < iters; it += 1) {
    const next = new Float64Array(dim);
    for (const row of rows) {
      let dot = 0;
      for (let i = 0; i < dim; i += 1) dot += row[i] * v[i];
      for (let i = 0; i < dim; i += 1) next[i] += dot * row[i];
    }
    const norm = normalizeInPlace(next);
    if (norm === 0) return v; // degenerate (all rows identical) — keep last v
    let diff = 0;
    for (let i = 0; i < dim; i += 1) diff += Math.abs(next[i] - v[i]);
    v = next;
    if (diff < 1e-7) break;
  }
  return v;
}

/** Remove the component along `axis` from every row (Gram-Schmidt deflation). */
function deflate(rows: Float64Array[], axis: Float64Array): void {
  const dim = axis.length;
  for (const row of rows) {
    let dot = 0;
    for (let i = 0; i < dim; i += 1) dot += row[i] * axis[i];
    for (let i = 0; i < dim; i += 1) row[i] -= dot * axis[i];
  }
}

function normalizeInPlace(v: Float64Array): number {
  let norm = 0;
  for (let i = 0; i < v.length; i += 1) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  if (norm === 0) return 0;
  for (let i = 0; i < v.length; i += 1) v[i] /= norm;
  return norm;
}

/** Recentre on the origin and rescale so the widest axis spans [-1, 1]. */
function normalizeToUnitCube(coords: Float64Array, n: number): void {
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < n; i += 1) {
    cx += coords[i * 3];
    cy += coords[i * 3 + 1];
    cz += coords[i * 3 + 2];
  }
  cx /= n; cy /= n; cz /= n;

  let maxAbs = 0;
  for (let i = 0; i < n; i += 1) {
    coords[i * 3] -= cx;
    coords[i * 3 + 1] -= cy;
    coords[i * 3 + 2] -= cz;
    for (let a = 0; a < 3; a += 1) {
      const v = Math.abs(coords[i * 3 + a]);
      if (v > maxAbs) maxAbs = v;
    }
  }
  if (maxAbs === 0) return;
  for (let i = 0; i < n * 3; i += 1) coords[i] /= maxAbs;
}

/**
 * Separation relaxation over the PCA initialisation. Two short-range forces,
 * iterated until the cloud stops overlapping itself:
 *
 *  - REPEL: any two stars closer than `minSep` are pushed apart to exactly that
 *    distance. This is the fix for "the memories converge into each other" — with
 *    thousands of claims, raw PCA piles most of the corpus into a dense core where
 *    individual stars are unclickable and unreadable.
 *  - ATTRACT: a KNN edge stretched past `minSep * edgeSlack` pulls back, so true
 *    neighbours stay adjacent while the repulsion inflates everything else.
 *
 * Both forces are LOCAL, so PCA's global arrangement survives — this de-densifies
 * the map, it does not re-derive it. Repulsion pairs come from a uniform spatial
 * hash rebuilt each iteration (cell = minSep, so only the 27 surrounding cells can
 * hold a colliding star), which is what keeps this O(n) per iteration instead of
 * O(n²). Deterministic: no RNG, fixed iteration count.
 */
function spreadLayout(
  coords: Float64Array,
  n: number,
  edges: ProjectionEdge[],
  index: Map<string, number>,
  opts: SpreadOptions,
): void {
  if (n < 3) return;

  // Nominal spacing if the n points were spread uniformly across the [-1,1] cube.
  const spacing = 2 / Math.cbrt(n);
  const minSep = spacing * opts.minSepScale;
  const edgeMax = minSep * opts.edgeSlack;
  const cell = minSep;

  // Resolve edges to index pairs once, outside the iteration loop.
  const ea = new Int32Array(edges.length);
  const eb = new Int32Array(edges.length);
  let m = 0;
  for (const e of edges) {
    const ai = index.get(e.a);
    const bi = index.get(e.b);
    if (ai === undefined || bi === undefined) continue;
    ea[m] = ai;
    eb[m] = bi;
    m += 1;
  }

  const buckets = new Map<string, number[]>();

  for (let iter = 0; iter < opts.iterations; iter += 1) {
    buckets.clear();
    for (let i = 0; i < n; i += 1) {
      const key = cellKey(coords[i * 3], coords[i * 3 + 1], coords[i * 3 + 2], cell);
      const bucket = buckets.get(key);
      if (bucket) bucket.push(i);
      else buckets.set(key, [i]);
    }

    for (let i = 0; i < n; i += 1) {
      const a = i * 3;
      const gx = Math.floor(coords[a] / cell);
      const gy = Math.floor(coords[a + 1] / cell);
      const gz = Math.floor(coords[a + 2] / cell);
      for (let ox = -1; ox <= 1; ox += 1) {
        for (let oy = -1; oy <= 1; oy += 1) {
          for (let oz = -1; oz <= 1; oz += 1) {
            const bucket = buckets.get(`${gx + ox},${gy + oy},${gz + oz}`);
            if (!bucket) continue;
            for (const j of bucket) {
              // Each unordered pair is resolved once, by its lower index.
              if (j <= i) continue;
              separate(coords, a, j * 3, minSep, opts.damping, i, j);
            }
          }
        }
      }
    }

    for (let e = 0; e < m; e += 1) {
      const a = ea[e] * 3;
      const b = eb[e] * 3;
      const dx = coords[b] - coords[a];
      const dy = coords[b + 1] - coords[a + 1];
      const dz = coords[b + 2] - coords[a + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d <= edgeMax || d < 1e-12) continue;
      // Pull each end halfway to the slack limit; damping keeps it from
      // oscillating against the repulsion that just ran.
      const f = (((d - edgeMax) / d) * 0.5 * opts.damping);
      coords[a] += dx * f;
      coords[a + 1] += dy * f;
      coords[a + 2] += dz * f;
      coords[b] -= dx * f;
      coords[b + 1] -= dy * f;
      coords[b + 2] -= dz * f;
    }
  }
}

/** Push two overlapping stars apart along their separating axis, in-place. */
function separate(
  coords: Float64Array,
  a: number,
  b: number,
  minSep: number,
  damping: number,
  ai: number,
  bi: number,
): void {
  let dx = coords[b] - coords[a];
  let dy = coords[b + 1] - coords[a + 1];
  let dz = coords[b + 2] - coords[a + 2];
  let d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (d >= minSep) return;
  if (d < 1e-12) {
    // Exactly coincident (duplicate embeddings): separate along an axis derived
    // from the index pair, so the split is deterministic but not always the same
    // direction for every collided pair.
    dx = ((ai % 3) - 1) || 1;
    dy = ((bi % 3) - 1) || 1;
    dz = (((ai + bi) % 3) - 1) || 1;
    d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  const f = ((minSep - d) / d) * 0.5 * damping;
  coords[a] -= dx * f;
  coords[a + 1] -= dy * f;
  coords[a + 2] -= dz * f;
  coords[b] += dx * f;
  coords[b + 1] += dy * f;
  coords[b + 2] += dz * f;
}

function cellKey(x: number, y: number, z: number, cell: number): string {
  return `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
}

/**
 * KNN edges by cosine over the FULL-dim vectors (not the projection — the whole
 * point is that the 3D distances lie). Vectors are unit-normalised once so cosine
 * is a dot product. Edges are undirected and de-duplicated; `sim` is the cosine.
 */
function knnEdges(claims: ClaimVec[], k: number): ProjectionEdge[] {
  const n = claims.length;
  const ids = claims.map((c) => c.id);
  const units = claims.map((c) => unit(c.vector));

  const seen = new Set<string>();
  const edges: ProjectionEdge[] = [];
  for (let i = 0; i < n; i += 1) {
    const neighbors: Array<{ j: number; sim: number }> = [];
    for (let j = 0; j < n; j += 1) {
      if (j === i) continue;
      neighbors.push({ j, sim: dot(units[i], units[j]) });
    }
    neighbors.sort((a, b) => b.sim - a.sim);
    for (const { j, sim } of neighbors.slice(0, k)) {
      const key = i < j ? `${i}:${j}` : `${j}:${i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ a: ids[i], b: ids[j], sim });
    }
  }
  return edges;
}

function unit(v: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i += 1) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  const out = new Float32Array(v.length);
  if (norm === 0) return out;
  for (let i = 0; i < v.length; i += 1) out[i] = v[i] / norm;
  return out;
}

function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
  return sum;
}
