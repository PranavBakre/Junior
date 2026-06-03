# Memory Local Embeddings

## Problem

The memory overhaul starts with OpenAI API embeddings because that is the fastest path to a working semantic recall channel. Long term, Junior may still need local embeddings for privacy, offline operation, cost control, or independence from API availability.

This doc keeps the local-provider design separate from the main overhaul so it does not block the first vector implementation.

## Relationship To The Overhaul

Primary plan:

- [Memory System Overhaul](memory-system-overhaul.md) owns the retrieval architecture, embedding cache, RRF fusion, vector candidate channel, eval, and latency gates.
- This doc owns the future local embedding provider.

The local provider must plug into the same `memory_embedding` table and provider interface. It should not change recall semantics.

## Decision

Local embeddings are a follow-up provider, not the first implementation.

Provider order for the full system:

1. `hashing` provider for deterministic tests and zero-dependency fallback.
2. `openai` provider for the first real semantic recall implementation.
3. `local` provider for offline/private operation once the recall pipeline is proven.

## Local Provider Shapes

### In-Process Model

```text
Junior process
  -> JavaScript/TypeScript embedding runtime
  -> local model files
  -> embedding vectors
```

Pros:

- fewer moving parts;
- no local HTTP service;
- easier to call from TypeScript if the runtime works cleanly with Bun.

Cons:

- model loading and native runtime issues live inside the Slack process;
- memory pressure competes with Junior;
- GPU/Metal/CPU setup can make deployment brittle;
- slow model load can affect startup.

### Local Sidecar

```text
Junior process
  -> http://127.0.0.1:<port>/embed or stdio command
  -> local embedding service
  -> local model files
  -> embedding vectors
```

Pros:

- model is loaded once and reused;
- native runtime quirks are isolated;
- easier to restart independently;
- safer for first production use.

Cons:

- another process to supervise;
- needs health checks and local auth/binding discipline;
- slightly more integration work.

Recommendation: use a sidecar first if local embeddings become necessary. It keeps model/runtime risk out of Junior's Slack control plane.

## Provider Requirements

The local provider must satisfy:

- no outbound network during recall;
- explicit local model path;
- deterministic provider/model id;
- fixed embedding dimension;
- batch embedding support for rebuild jobs;
- health check;
- clear timeout and failure behavior;
- recall degrades to non-vector channels if unavailable;
- output vectors encoded the same way as OpenAI vectors in `memory_embedding`;
- no embedding work in Slack ingest.

Suggested config:

```text
MEMORY_VECTOR_PROVIDER=local
MEMORY_VECTOR_MODEL=<local-model-id>
MEMORY_VECTOR_MODEL_PATH=data/models/<model>
MEMORY_VECTOR_ENDPOINT=http://127.0.0.1:8765/embed
MEMORY_VECTOR_BATCH_SIZE=32
MEMORY_VECTOR_TIMEOUT_MS=30000
```

## Model Choice

Pick a small sentence-embedding model first. The goal is not the best possible leaderboard model. The goal is:

```text
better recall@k than FTS/tag/entity alone
acceptable p95 latency
reasonable memory use
simple local deployment
```

Evaluation should compare:

- OpenAI `text-embedding-3-small` baseline from the main overhaul;
- local model at its native dimension;
- local model with any available quantization/runtime options;
- hashing fallback.

## Cache Contract

Local embeddings use the same cache:

```sql
CREATE TABLE IF NOT EXISTS memory_embedding (
  memory_id TEXT NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  embedding BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (memory_id, model),
  FOREIGN KEY (memory_id) REFERENCES memory_search_doc(id)
);
```

Rules:

- `model` must include enough information to distinguish local model, quantization, and dimension.
- stale `content_hash` rows are ignored;
- BLOB encoding remains little-endian `Float32Array`;
- dimension validation is mandatory;
- cache rebuild is a workflow/background job.

## Rollout

1. Prove the vector channel with OpenAI embeddings.
2. Add a provider interface that can swap OpenAI for local without changing recall scoring.
3. Build a local sidecar spike.
4. Run the same recall eval and latency benchmark against both providers.
5. Enable local provider only if it meets quality and p95 gates.

## Open Questions

- Which local model gives the best quality/deployment tradeoff on the operator's hardware?
- Should the sidecar be Node, Python, or another runtime?
- Should model files live in `data/models`, a user-configured path, or outside the Junior repo entirely?
- Do we need GPU/Metal acceleration, or is CPU enough for background rebuild and query embedding?
- What should the sidecar supervision/restart mechanism be?

## Final Position

Local embeddings are desirable, but not the first step. Start with OpenAI API embeddings to validate whether semantic recall improves Junior's memory. Once the pipeline, cache, RRF fusion, and eval gates are proven, add local embeddings as a provider swap.
