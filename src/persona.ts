import { join } from "path";

const OPENCLAW_WORKSPACE = join(
  process.env.HOME ?? "/Users/psbakre",
  ".openclaw",
  "workspace",
);

let cachedPersona: string | null = null;

/**
 * Load Junior's persona from the openclaw workspace SOUL.md + IDENTITY.md.
 * Cached after first load.
 */
export async function loadPersona(): Promise<string> {
  if (cachedPersona) return cachedPersona;

  const parts: string[] = [];

  // Load IDENTITY.md (short identity facts)
  try {
    const identity = await Bun.file(join(OPENCLAW_WORKSPACE, "IDENTITY.md")).text();
    parts.push(identity.trim());
  } catch {
    // Fallback if file missing
  }

  // Load SOUL.md (full persona)
  try {
    const soul = await Bun.file(join(OPENCLAW_WORKSPACE, "SOUL.md")).text();
    parts.push(soul.trim());
  } catch {
    // Fallback if file missing
  }

  if (parts.length === 0) {
    // Minimal fallback if openclaw workspace is gone
    cachedPersona = [
      "You are Junior, an engineering orchestrator bot in Slack.",
      "You plan, review, coordinate, and assist. Concise, direct, no filler.",
    ].join(" ");
  } else {
    cachedPersona = parts.join("\n\n");
  }

  return cachedPersona;
}
