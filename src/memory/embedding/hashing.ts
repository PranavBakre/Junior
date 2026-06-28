import type { EmbeddingProvider, EmbedMode } from "./types.ts";

/**
 * Deterministic, zero-dependency embedding provider for tests.
 *
 * Uses the classic feature-hashing ("hashing trick") signed-bucket scheme:
 * each whitespace token is hashed; its low bits pick a bucket and one more bit
 * picks a sign; magnitudes accumulate; the vector is L2-normalized. This gives
 * a stable, fast, offline stand-in for a real semantic model — identical input
 * always yields an identical vector, and lexically-overlapping texts land near
 * each other — without pulling model weights. It is NOT semantic (no synonymy);
 * it exists so session/store tests can run with a real `EmbeddingProvider`
 * shape and no network.
 *
 * Defaults to dim 640 so it is a drop-in for the local harrier provider in
 * tests that assert on dimensionality.
 */
export class HashingEmbeddingProvider implements EmbeddingProvider {
  readonly model = "hashing";
  readonly dim: number;

  constructor(dim = 640) {
    if (dim <= 0 || !Number.isInteger(dim)) {
      throw new Error(`HashingEmbeddingProvider: dim must be a positive integer, got ${dim}`);
    }
    this.dim = dim;
  }

  // mode is accepted for interface parity; the hashing scheme ignores it
  // (no instruction templating — it operates on raw tokens).
  async embed(texts: string[], _mode: EmbedMode): Promise<Float32Array[]> {
    return texts.map((t) => this.embedOne(t));
  }

  private embedOne(text: string): Float32Array {
    const vec = new Float32Array(this.dim);
    const tokens = tokenize(text);
    for (const tok of tokens) {
      const h = fnv1a(tok);
      const bucket = h % this.dim;
      const sign = (h >>> 31) & 1 ? -1 : 1;
      vec[bucket] += sign;
    }
    l2NormalizeInPlace(vec);
    return vec;
  }
}

/** Lowercase, split on non-alphanumeric runs, drop empties. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((s) => s.length > 0);
}

/** 32-bit FNV-1a — deterministic, well-distributed, no dependencies. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // h *= 16777619, kept in 32-bit unsigned range via Math.imul
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** L2-normalize a vector in place. Zero vectors are left untouched. */
function l2NormalizeInPlace(vec: Float32Array): void {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum);
  if (norm === 0) return;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
}
