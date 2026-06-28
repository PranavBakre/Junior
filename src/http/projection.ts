/**
 * 2D projection of the claim embedding space for the dashboard's "memory cloud"
 * debug view. Everything here is computed AT RENDER TIME from the raw vectors and
 * is NOT stored — it is exploration, not a precise map.
 *
 * IMPORTANT CAVEAT (surfaced in the UI too): projecting a 640-dim space to 2D
 * with PCA preserves the directions of greatest variance, but it DISTORTS. Local
 * neighbourhoods (which points sit near which) are meaningful; absolute positions
 * and global distances are NOT. Two clusters far apart on screen may be close in
 * the full space, and vice-versa. Read the KNN edges, not the coordinates.
 *
 * Implementation is dependency-free: PCA's top-2 principal components are found
 * by matrix-free power iteration (the dominant eigenvector of the covariance,
 * computed as Xᵀ(Xv) without ever materialising the 640×640 covariance matrix),
 * then deflation for the second component. For the claim corpus (low thousands of
 * 640-dim vectors, per memory-system-v3.md §6.2) this is a sub-second compute.
 */

export interface ClaimVec {
  id: string;
  kind: string;
  text: string;
  tags: string[];
  vector: Float32Array;
}

export interface ProjectionPoint {
  id: string;
  x: number;
  y: number;
  kind: string;
  text: string;
  tags: string[];
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

/**
 * Project claims to 2D via PCA and compute KNN edges (cosine, default k=5).
 * Guards the 0–1 claim case gracefully: points collapse to the origin and there
 * are no edges (the store may be near-empty pre-migration).
 */
export function projectClaims(claims: ClaimVec[], k = 5): ProjectionResult {
  const n = claims.length;
  if (n <= 1) {
    return {
      points: claims.map((c) => ({ id: c.id, x: 0, y: 0, kind: c.kind, text: c.text, tags: c.tags })),
      edges: [],
    };
  }

  const dim = claims[0].vector.length;

  // Mean-center: PCA requires the data be centred on the origin.
  const mean = new Float64Array(dim);
  for (const c of claims) for (let i = 0; i < dim; i += 1) mean[i] += c.vector[i];
  for (let i = 0; i < dim; i += 1) mean[i] /= n;

  const centered: Float64Array[] = claims.map((c) => {
    const row = new Float64Array(dim);
    for (let i = 0; i < dim; i += 1) row[i] = c.vector[i] - mean[i];
    return row;
  });

  // Top-2 principal components by power iteration + deflation.
  const pc1 = powerIteration(centered, dim);
  deflate(centered, pc1);
  const pc2 = powerIteration(centered, dim);

  // Project the (now deflated) original-centred data. Recompute centred rows so
  // the projection uses the full variance, not the deflated residual.
  const points: ProjectionPoint[] = claims.map((c) => {
    let x = 0;
    let y = 0;
    for (let i = 0; i < dim; i += 1) {
      const v = c.vector[i] - mean[i];
      x += v * pc1[i];
      y += v * pc2[i];
    }
    return { id: c.id, x, y, kind: c.kind, text: c.text, tags: c.tags };
  });

  return { points, edges: knnEdges(claims, k) };
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

/**
 * KNN edges by cosine over the FULL-dim vectors (not the projection — the whole
 * point is that the 2D distances lie). Vectors are unit-normalised once so cosine
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
