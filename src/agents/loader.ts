export interface AgentDefinition {
  name: string;
  description: string;
  tools: string | null;
  model: string | null;
  prompt: string;
}

export async function loadAgentDefinition(
  filePath: string,
): Promise<AgentDefinition | null> {
  const file = Bun.file(filePath);
  const exists = await file.exists();
  if (!exists) return null;

  const content = await file.text();
  const { frontmatter, body } = parseFrontmatter(content);

  return {
    name: frontmatter["name"] ?? "",
    description: frontmatter["description"] ?? "",
    tools: frontmatter["tools"] ?? null,
    model: frontmatter["model"] ?? null,
    prompt: body.trim(),
  };
}

function parseFrontmatter(content: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const frontmatter: Record<string, string> = {};

  if (!content.startsWith("---")) {
    return { frontmatter, body: content };
  }

  const firstDelim = content.indexOf("---");
  const secondDelim = content.indexOf("---", firstDelim + 3);

  if (secondDelim === -1) {
    return { frontmatter, body: content };
  }

  const fmBlock = content.slice(firstDelim + 3, secondDelim).trim();
  const body = content.slice(secondDelim + 3);

  for (const line of fmBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();

    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key) {
      frontmatter[key] = value;
    }
  }

  return { frontmatter, body };
}
