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

/**
 * Build three independent question+lesson projections. Keeping them as
 * separate vectors lets a blurry query match its closest phrasing instead of
 * averaging all cues into one diluted document vector.
 */
export function buildLessonRetrievalTexts(input: {
  title: string;
  body: string;
  appliesWhen?: string | null;
}): [string, string, string] {
  const title = compact(input.title);
  const body = compact(input.body);
  const situation = (compact(input.appliesWhen ?? "") || title)
    .replace(/[.!?]+$/, "");
  const lesson = body === title ? body : `${title}\n${body}`;
  return [
    `What should I do in this situation: ${situation}?\n${lesson}`,
    `Which prior lesson applies when ${situation}?\n${lesson}`,
    `How should I avoid mistakes when ${situation}?\n${lesson}`,
  ];
}

export function buildFactRetrievalText(input: {
  title?: string | null;
  body: string;
}): string {
  return [compact(input.title ?? ""), compact(input.body)]
    .filter(Boolean)
    .join("\n");
}
