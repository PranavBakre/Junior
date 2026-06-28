import type { EmbeddingProvider } from "./types.ts";
import { HashingEmbeddingProvider } from "./hashing.ts";
import { LocalEmbeddingProvider } from "./local.ts";

export type EmbeddingProviderKind = "hashing" | "local";

/**
 * Select an embedding provider (provider/factory pattern, CLAUDE.md rule 13):
 *  - "local"   → harrier-270 ONNX, in-process, last-token pooling (production).
 *  - "hashing" → deterministic zero-dependency stand-in (tests/dev, no weights).
 */
export function createEmbeddingProvider(
  kind: EmbeddingProviderKind,
): EmbeddingProvider {
  switch (kind) {
    case "local":
      return new LocalEmbeddingProvider();
    case "hashing":
      return new HashingEmbeddingProvider();
    default: {
      const _exhaustive: never = kind;
      throw new Error(`Unknown embedding provider kind: ${_exhaustive}`);
    }
  }
}
