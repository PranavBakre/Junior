import { join, dirname } from "path";
import { fileURLToPath } from "url";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const IDENTITY_DIR = join(PROJECT_ROOT, "identity", "junior");

let cachedPersona: string | null = null;

export async function loadPersona(): Promise<string> {
  if (cachedPersona) return cachedPersona;

  const parts: string[] = [];

  try {
    const identity = await Bun.file(join(IDENTITY_DIR, "IDENTITY.md")).text();
    parts.push(identity.trim());
  } catch {
    // Fallback if file missing
  }

  try {
    const soul = await Bun.file(join(IDENTITY_DIR, "SOUL.md")).text();
    parts.push(soul.trim());
  } catch {
    // Fallback if file missing
  }

  if (parts.length === 0) {
    cachedPersona = [
      "You are Junior, an engineering orchestrator bot in Slack.",
      "You plan, review, coordinate, and assist. Concise, direct, no filler.",
    ].join(" ");
  } else {
    cachedPersona = parts.join("\n\n");
  }

  return cachedPersona;
}
