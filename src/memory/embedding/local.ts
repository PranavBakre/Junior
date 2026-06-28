import {
  AutoModel,
  AutoTokenizer,
  type PreTrainedModel,
  type PreTrainedTokenizer,
} from "@huggingface/transformers";
import type { EmbeddingProvider, EmbedMode } from "./types.ts";

/**
 * Local, in-process embedding provider backed by
 * `onnx-community/harrier-oss-v1-270m-ONNX` (Microsoft harrier-oss-v1, a
 * decoder-only / Gemma3-text multilingual embedder, 640-dim, MIT). Runs via
 * @huggingface/transformers on onnxruntime-node (CPU) — no Python/MLX sidecar.
 * Affective memory must never leave for a remote API (memory-system-v3.md §9),
 * so the embedder is local-first.
 *
 * ── POOLING (the silent-failure trap) ───────────────────────────────────────
 * harrier is DECODER-ONLY → it needs LAST-TOKEN pooling + L2-normalize, NOT the
 * mean pooling that the transformers.js `feature-extraction` pipeline defaults
 * to. Mean pooling produces wrong vectors with no error, just bad recall. We
 * therefore use the raw `AutoModel` forward pass (never the pipeline). The ONNX
 * graph for this repo bakes last-token pooling + L2-normalization directly into
 * the model and exposes the result as the `sentence_embedding` output — verified
 * in the spike: ‖v‖ == 1.0000 straight out of the model. We read that output
 * directly; we do not touch `last_hidden_state` ourselves.
 *
 * ── PROMPT TEMPLATES (Qwen3-embedding-family / harrier convention) ───────────
 * Per the model card FAQ: instructions go on the QUERY side only; documents are
 * embedded raw. The query template is:
 *     "Instruct: {task}\nQuery: {text}"
 * with a one-sentence task description. Documents get NO prefix. Using the wrong
 * template (or none on queries) degrades retrieval. See QUERY_INSTRUCTION below.
 *
 * ── RUNTIME REQUIREMENT ──────────────────────────────────────────────────────
 * This model's ONNX graph uses GroupQueryAttention (11-input signature) and
 * GatherBlockQuantized (`bits` attr). Those ops require onnxruntime-node ≥ 1.24
 * (shipped by @huggingface/transformers ≥ 4.x). Older runtimes (1.21, bundled
 * with transformers 3.x) reject the graph at load time. The onnxruntime-node
 * native postinstall must also be trusted/built (`bun pm trust onnxruntime-node`).
 */

const MODEL_ID = "onnx-community/harrier-oss-v1-270m-ONNX";
const DIM = 640;

/**
 * One-sentence task description for the query-side instruction. harrier is
 * instruction-tuned; a retrieval-flavoured task description matches how Junior
 * uses it (find claims/lessons relevant to the current query). Documents
 * (stored claims) are embedded WITHOUT any instruction.
 */
const QUERY_INSTRUCTION =
  "Given a search query, retrieve relevant passages that answer the query";
const QUERY_PREFIX = `Instruct: ${QUERY_INSTRUCTION}\nQuery: `;

interface LoadedModel {
  tokenizer: PreTrainedTokenizer;
  model: PreTrainedModel;
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly model = MODEL_ID;
  readonly dim = DIM;

  // Lazily initialized once and cached. The promise is cached (not just the
  // resolved value) so concurrent first calls share a single load.
  private loaded: Promise<LoadedModel> | null = null;

  private load(): Promise<LoadedModel> {
    if (!this.loaded) {
      this.loaded = (async () => {
        const [tokenizer, model] = await Promise.all([
          AutoTokenizer.from_pretrained(MODEL_ID),
          // dtype q8: ~270MB RAM, well under the 1GB ceiling (memory-v3 §10).
          AutoModel.from_pretrained(MODEL_ID, { dtype: "q8" }),
        ]);
        return { tokenizer, model };
      })().catch((err) => {
        // Reset so a transient failure (e.g. download) can be retried.
        this.loaded = null;
        throw err;
      });
    }
    return this.loaded;
  }

  async embed(texts: string[], mode: EmbedMode): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    const { tokenizer, model } = await this.load();

    // Embed ONE text per forward pass — never a padded batch. harrier is
    // decoder-only with LAST-TOKEN pooling; in a padded multi-text batch the
    // shorter texts get pooled from a PAD position and silently produce a
    // wrong vector (verified: a batch-padded short text scores ~0.22 cosine
    // against its own size-1 embedding — i.e. garbage). transformers.js did
    // NOT honor a left-padding override here, so we sidestep padding entirely.
    // Cost is throughput on bulk/offline embedding (e.g. the P3 corpus
    // backfill); correctness is non-negotiable. Regression-guarded by the
    // batch-vs-single test in embedding.test.ts.
    const result: Float32Array[] = new Array(texts.length);
    for (let i = 0; i < texts.length; i++) {
      const prepared = mode === "query" ? QUERY_PREFIX + texts[i] : texts[i];
      const inputs = tokenizer([prepared], { truncation: true });
      const out = await model(inputs);

      const tensor = out.sentence_embedding;
      if (!tensor) {
        throw new Error(
          `LocalEmbeddingProvider: model did not return a 'sentence_embedding' output (got keys: ${Object.keys(out).join(", ")})`,
        );
      }
      const [, dim] = tensor.dims as [number, number];
      if (dim !== this.dim) {
        throw new Error(
          `LocalEmbeddingProvider: expected dim ${this.dim}, got ${dim}`,
        );
      }
      // tensor.data is the flat Float32Array for this single row, already
      // last-token-pooled and L2-normalized by the ONNX graph. slice() copies.
      result[i] = (tensor.data as Float32Array).slice(0, dim);
    }
    return result;
  }
}
