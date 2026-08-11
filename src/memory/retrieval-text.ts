function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Build a deterministic retrieval projection for a curated lesson. The
 * authoritative title/body remain unchanged; this string exists only to make
 * the situation in which the lesson applies visible to the embedder.
 */
export function buildLessonRetrievalText(input: {
  title: string;
  body: string;
  appliesWhen?: string | null;
}): string {
  const title = compact(input.title);
  const body = compact(input.body);
  const appliesWhen = compact(input.appliesWhen ?? "");
  const parts = [
    title,
    appliesWhen ? `Use this lesson when: ${appliesWhen}` : "",
    body,
  ].filter(Boolean);
  return parts.join("\n");
}

export function buildFactRetrievalText(input: {
  title?: string | null;
  body: string;
}): string {
  return [compact(input.title ?? ""), compact(input.body)]
    .filter(Boolean)
    .join("\n");
}
