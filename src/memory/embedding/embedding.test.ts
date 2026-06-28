import { describe, expect, it } from "bun:test";
import { HashingEmbeddingProvider } from "./hashing.ts";
import { LocalEmbeddingProvider } from "./local.ts";
import { createEmbeddingProvider } from "./factory.ts";
import type { EmbeddingProvider } from "./types.ts";

/**
 * The local provider pulls ~270MB of model weights on first run, so its test
 * only runs when RUN_LOCAL_EMBED_TEST=1. The hashing-provider tests always run.
 */
const RUN_LOCAL = process.env.RUN_LOCAL_EMBED_TEST === "1";

function l2(v: Float32Array): number {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s);
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot / (l2(a) * l2(b));
}

describe("HashingEmbeddingProvider", () => {
  it("is deterministic: same input → identical vector", async () => {
    const p = new HashingEmbeddingProvider();
    const [a] = await p.embed(["the quick brown fox"], "document");
    const [b] = await p.embed(["the quick brown fox"], "document");
    expect(a.length).toBe(640);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("ignores mode (same vector for query and document)", async () => {
    const p = new HashingEmbeddingProvider();
    const [q] = await p.embed(["hello world"], "query");
    const [d] = await p.embed(["hello world"], "document");
    expect(Array.from(q)).toEqual(Array.from(d));
  });

  it("produces L2-normalized vectors for non-empty input", async () => {
    const p = new HashingEmbeddingProvider();
    const [v] = await p.embed(["alpha beta gamma delta"], "document");
    expect(l2(v)).toBeCloseTo(1, 5);
  });

  it("respects a custom dimensionality", async () => {
    const p = new HashingEmbeddingProvider(128);
    const [v] = await p.embed(["sizing test"], "document");
    expect(v.length).toBe(128);
    expect(p.dim).toBe(128);
  });

  it("leaves an all-stopword / empty text as a zero vector (no NaN)", async () => {
    const p = new HashingEmbeddingProvider();
    const [v] = await p.embed(["!!! ??? ..."], "document");
    expect(v.every((x) => x === 0)).toBe(true);
    expect(v.some((x) => Number.isNaN(x))).toBe(false);
  });

  it("preserves input order and length in a batch", async () => {
    const p = new HashingEmbeddingProvider();
    const out = await p.embed(["one", "two", "three"], "document");
    expect(out.length).toBe(3);
    const single = (await p.embed(["two"], "document"))[0];
    expect(Array.from(out[1])).toEqual(Array.from(single));
  });

  it("returns [] for an empty batch", async () => {
    const p = new HashingEmbeddingProvider();
    expect(await p.embed([], "document")).toEqual([]);
  });
});

describe("createEmbeddingProvider", () => {
  it("builds a hashing provider", () => {
    const p = createEmbeddingProvider("hashing");
    expect(p.model).toBe("hashing");
    expect(p.dim).toBe(640);
  });

  it("builds a local provider", () => {
    const p = createEmbeddingProvider("local");
    expect(p.model).toBe("onnx-community/harrier-oss-v1-270m-ONNX");
    expect(p.dim).toBe(640);
  });
});

// Cosine-sanity for the real model. Skipped unless RUN_LOCAL_EMBED_TEST=1
// (downloads weights). Guards against the mean-pooling trap: with correct
// last-token pooling, a related query/document pair must out-score an
// unrelated one by a wide margin.
describe.skipIf(!RUN_LOCAL)("LocalEmbeddingProvider (model download required)", () => {
  it("ranks a related document above an unrelated one", async () => {
    const provider: EmbeddingProvider = new LocalEmbeddingProvider();

    const [query] = await provider.embed(
      ["how much protein should a woman eat per day"],
      "query",
    );
    const docs = await provider.embed(
      [
        "The CDC recommends women ages 19 to 70 consume about 46 grams of protein per day.",
        "Mount Everest is the highest mountain on Earth, located in the Himalayas.",
      ],
      "document",
    );

    expect(query.length).toBe(640);
    // Output is already L2-normalized by the ONNX graph.
    expect(l2(query)).toBeCloseTo(1, 3);
    expect(l2(docs[0])).toBeCloseTo(1, 3);

    const related = cosine(query, docs[0]);
    const unrelated = cosine(query, docs[1]);
    expect(related).toBeGreaterThan(unrelated);
    // Comfortable separation, not a coin-flip.
    expect(related - unrelated).toBeGreaterThan(0.15);
  }, 120_000);

  // Regression guard for the batch padding-side trap: with LEFT padding, a
  // text embedded inside a mixed-length batch must match the same text
  // embedded alone. Right padding would pool a short text from a PAD position
  // and silently diverge here. This is the trap that would poison the P3
  // corpus backfill (batched), where production today only ever embeds size-1.
  it("batch embedding matches single embedding (padding-side correctness)", async () => {
    const provider: EmbeddingProvider = new LocalEmbeddingProvider();
    const short = "merge PRs with a 3-way merge";
    const long =
      "When the bug pipeline reaches review-approved, open a parallel PR to dev, merge it with the admin account, validate on the dev environment, and only then is the main PR ready for a human to merge.";

    const [solo] = await provider.embed([short], "document");
    const batch = await provider.embed([long, short], "document");
    // batch[1] is the short text, padded alongside the longer one.
    const agree = cosine(solo, batch[1]);
    expect(agree).toBeGreaterThan(0.999);
  }, 120_000);
});
