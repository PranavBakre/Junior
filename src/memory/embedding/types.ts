/**
 * Embedding provider contract for Junior's memory system (v3).
 *
 * Two retrieval modes drive everything downstream (see
 * docs/features/memory-system-v3.md §10): the same model embeds both the
 * stored corpus ("document") and the live query ("query"), but harrier (the
 * Qwen3-embedding-family decoder) wants an *instruction prefix on the query
 * side only*. The `mode` argument selects that template — callers never build
 * the prefix themselves.
 */
export type EmbedMode = "query" | "document";

export interface EmbeddingProvider {
  /** Model identifier (HF repo id, or "hashing" for the test provider). */
  readonly model: string;
  /** Output vector dimensionality. harrier-270 → 640. */
  readonly dim: number;
  /**
   * Embed a batch of texts. Returns one L2-normalized Float32Array per input,
   * in the same order. `mode` decides query-vs-document prompt templating.
   */
  embed(texts: string[], mode: EmbedMode): Promise<Float32Array[]>;
}
