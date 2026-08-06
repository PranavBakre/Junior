/** Parsed representation of the lightweight YAML-compatible frontmatter used
 * by agent Markdown files. Agent metadata intentionally stays flat so the
 * same parser works for public and private definitions without a YAML runtime.
 */
export interface AgentDocument {
  frontmatter: Record<string, string>;
  body: string;
}

export function parseAgentFrontmatter(content: string): AgentDocument {
  const frontmatter: Record<string, string> = {};

  if (!content.startsWith("---")) {
    return { frontmatter, body: content };
  }

  const secondDelim = content.indexOf("---", 3);
  if (secondDelim === -1) {
    return { frontmatter, body: content };
  }

  const fmBlock = content.slice(3, secondDelim).trim();
  const body = content.slice(secondDelim + 3);

  for (const line of fmBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key) frontmatter[key] = value;
  }

  return { frontmatter, body };
}

export function parseFrontmatterCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}
