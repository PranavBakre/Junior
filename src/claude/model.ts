/**
 * Resolve the model id to pass to the Claude runner CLI.
 *
 * Mirrors `codexCompatibleModel` in `src/codex-app-server/spawner.ts` but in
 * the opposite direction: instead of stripping Claude aliases so Codex doesn't
 * choke, this function maps GPT/OpenAI model ids (historically written in agent
 * frontmatter when Codex was the active runner) to their Claude equivalents so
 * Claude doesn't choke.
 *
 * Product decision: `gpt-5.5` maps to `opus` — the two were considered
 * equivalent capability tiers at the point of the runner switch.
 */

/**
 * GPT/OpenAI model → Claude model alias.
 *
 * Keys are lowercase. Entries cover only the models that appeared in production
 * agent frontmatter; anything not listed falls through to `configDefaultModel`.
 */
const GPT_TO_CLAUDE: Record<string, string> = {
  "gpt-5.5": "opus",
};

/**
 * Resolve which model id to hand the Claude runner.
 *
 * Precedence:
 * 1. `modelClaude` — explicit per-agent Claude override (wins unconditionally).
 * 2. `sessionModel` already a Claude model (alias or full id) — pass through.
 * 3. `sessionModel` is a GPT/OpenAI id — map via `GPT_TO_CLAUDE`; unmapped
 *    ids fall back to `configDefaultModel`.
 * 4. `sessionModel` is null → `configDefaultModel`.
 *    `sessionModel` is an unrecognised non-null string → `configDefaultModel`
 *    (safe path; we won't pass an unknown non-Claude id to Claude).
 */
export function resolveClaudeModel(input: {
  modelClaude?: string | null;
  sessionModel: string | null;
  configDefaultModel: string | null;
}): string | null {
  const { modelClaude, sessionModel, configDefaultModel } = input;

  // 1. Explicit per-agent Claude override always wins.
  if (modelClaude) return modelClaude;

  // 2. Session model is already a Claude model — pass through verbatim.
  if (sessionModel && isClaudeModel(sessionModel)) return sessionModel;

  // 3. Session model is a GPT/OpenAI model — map or fall back.
  if (sessionModel && isGptModel(sessionModel)) {
    const mapped = GPT_TO_CLAUDE[sessionModel.toLowerCase()];
    return mapped ?? configDefaultModel;
  }

  // 4. Null or unrecognised non-Claude, non-GPT string → fall back.
  return configDefaultModel;
}

function isClaudeModel(model: string): boolean {
  return /^(opus|sonnet|haiku|fable)$/i.test(model) || /^claude[-/]/i.test(model);
}

function isGptModel(model: string): boolean {
  return /^gpt[-/]/i.test(model) || /^o[0-9]/i.test(model);
}
