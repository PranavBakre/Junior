/**
 * Resolve the model reference to hand the OpenCode runner (`--model`).
 *
 * Mirrors `resolveClaudeModel` in `src/claude/model.ts` and `resolveCodexModel`
 * in `src/codex-app-server/spawner.ts`, but for OpenCode's provider/model
 * addressing scheme.
 *
 * OpenCode's `--model` flag expects a `provider/model` reference (e.g.
 * `anthropic/claude-sonnet-4-5`, `openai/gpt-5.5`). A slashless string like
 * `gpt-5.5` parses as providerID=`gpt-5.5`, modelID=`` — no such provider
 * exists, so OpenCode's embedded server throws "Unexpected server error" and
 * the CLI exits 1 before producing any output.
 *
 * Agent frontmatter historically carried bare Claude/Codex aliases (`gpt-5.5`,
 * `opus`, `haiku`, `sonnet`) meant for those runners. None of them is a usable
 * OpenCode reference. Rather than invent a per-alias mapping, fall back to the
 * configured OpenCode default (when it is itself a valid ref), else return null.
 * null means: omit `--model` entirely so OpenCode uses its own configured
 * default — exactly how the working default-agent turns run today.
 */

import { log } from "../logger.ts";

/**
 * A model string is a usable OpenCode reference only in `provider/model` form.
 */
function isOpenCodeModelRef(model: string | null | undefined): model is string {
  return typeof model === "string" && model.includes("/");
}

/**
 * Resolve which model reference to pass to the OpenCode runner.
 *
 * Precedence:
 * 1. `sessionModel` already a valid OpenCode ref (`provider/model`) — pass through.
 * 2. `sessionModel` set but not a valid ref (a Claude/Codex alias) — ignore it
 *    for the OpenCode provider (warn) and fall back to `configDefaultModel`.
 * 3. `configDefaultModel` is a valid ref → use it. Otherwise null (omit
 *    `--model` so OpenCode uses its own configured default).
 */
export function resolveOpenCodeModel(
  sessionModel: string | null | undefined,
  configDefaultModel: string | null | undefined,
): string | null {
  // 1. Session model is already a valid OpenCode reference — pass through.
  if (isOpenCodeModelRef(sessionModel)) return sessionModel;

  // 2. Session model set but not a valid ref: a runner-specific alias. Ignore
  //    it for the OpenCode provider and fall back to the configured default.
  if (sessionModel) {
    log.warn(
      "opencode",
      `Session model "${sessionModel}" is not a valid OpenCode provider/model reference; ignoring it for the opencode provider and using the configured default`,
    );
  }

  // 3. Configured default if it is itself a valid ref, else null (omit --model).
  if (isOpenCodeModelRef(configDefaultModel)) return configDefaultModel;

  return null;
}
