import { describe, expect, test } from "bun:test";

import { buildLessonRetrievalTexts } from "./retrieval-text.ts";

describe("buildLessonRetrievalTexts", () => {
  test("creates three distinct question+lesson projections", () => {
    const texts = buildLessonRetrievalTexts({
      title: "Verify liveness before intervention",
      body: "Inspect durable progress before restarting the worker.",
      appliesWhen: "a background job appears stalled",
    });

    expect(texts).toHaveLength(3);
    expect(new Set(texts).size).toBe(3);
    for (const text of texts) {
      expect(text).toContain("a background job appears stalled");
      expect(text).toContain("Inspect durable progress");
      expect(text).toContain("?");
    }
  });
});
