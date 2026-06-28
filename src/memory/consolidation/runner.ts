// Production adapter for the consolidation engine (memory v3 §7).
//
// `consolidate.ts` keeps the engine pure: it asks an injected `ConsolidationInvoke`
// for derivations. This file is the real runner behind that contract — a one-shot
// `claude -p` subprocess (CLAUDE.md rule 1: CLI subprocess, not SDK) that is told
// to return ONLY JSON conforming to `consolidationOutputSchema`. We append the
// schema + a "JSON only" instruction to the prompt, collect the model's final
// text, strip any code fences, parse it, and validate the shape before handing it
// back. The subprocess is INJECTABLE (`runText`) so tests never spawn a real CLI.
//
// On any malformed output we throw a clear error — the caller treats a failed
// consolidation as a no-op for that session (the records stay unconsolidated and
// get retried), never a crash.

import { signalProcessTree } from "../../lifecycle/process-tree.ts";
import { consolidationOutputSchema } from "./types.ts";
import type { ConsolidationInvoke, ConsolidationOutput } from "./types.ts";

/** Default per-run timeout guard (CLAUDE.md rule 12). 5 minutes. */
export const DEFAULT_CONSOLIDATION_TIMEOUT_MS = 5 * 60_000;

/**
 * The injectable subprocess boundary: given the (schema-augmented) prompt, run a
 * model and return its FINAL assistant text. The default implementation spawns
 * `claude -p`; tests pass a fake that returns canned text without spawning.
 */
export type RunText = (req: {
  prompt: string;
  timeoutMs: number;
  model?: string;
}) => Promise<string>;

export interface RunnerInvokeOptions {
  /** Timeout guard in ms (default 5 min). Kills the subprocess tree on expiry. */
  timeoutMs?: number;
  /** Optional model override passed through to `claude --model`. */
  model?: string;
  /** Subprocess injection point. Defaults to a real one-shot `claude -p` run. */
  runText?: RunText;
}

/**
 * Build the production `ConsolidationInvoke`: append the JSON-only output
 * contract to the consolidation prompt, run the model, then parse + validate.
 */
export function createRunnerInvoke(opts: RunnerInvokeOptions = {}): ConsolidationInvoke {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CONSOLIDATION_TIMEOUT_MS;
  const runText = opts.runText ?? defaultRunText;
  return async (prompt: string): Promise<ConsolidationOutput> => {
    const raw = await runText({ prompt: appendOutputContract(prompt), timeoutMs, model: opts.model });
    return parseConsolidationOutput(raw);
  };
}

/**
 * Append the structured-output contract: the model must return ONLY JSON
 * matching `consolidationOutputSchema`. The schema is inlined (it is a plain
 * object literal, no schema-library dependency) so the model sees the exact
 * shape it must produce.
 */
export function appendOutputContract(prompt: string): string {
  return [
    prompt,
    "",
    "## OUTPUT CONTRACT (read carefully)",
    "Respond with JSON ONLY. No prose, no explanation, no markdown, no code fences.",
    "Your ENTIRE response must be a single JSON object conforming to this JSON Schema:",
    "",
    JSON.stringify(consolidationOutputSchema, null, 2),
    "",
    'If nothing durable should be remembered (the common case), respond with exactly:',
    '{"episodes":[],"profiles":[],"claims":[]}',
  ].join("\n");
}

/**
 * Parse the model's final text into a `ConsolidationOutput`. Strips code fences,
 * extracts the JSON object, parses, and validates the top-level shape. Missing
 * arrays coerce to `[]`; a present-but-wrong-typed field (or non-object / unparsable
 * output) throws a clear error so the caller can no-op the session.
 */
export function parseConsolidationOutput(raw: string): ConsolidationOutput {
  const json = extractJsonObject(raw);
  if (!json) {
    throw new Error("consolidation runner: model returned no JSON object");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`consolidation runner: model output is not valid JSON (${reason})`);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("consolidation runner: model output is not a JSON object");
  }

  const obj = parsed as Record<string, unknown>;
  return {
    episodes: coerceArray(obj.episodes, "episodes"),
    profiles: coerceArray(obj.profiles, "profiles"),
    claims: coerceArray(obj.claims, "claims"),
  } as ConsolidationOutput;
}

/**
 * Missing key -> `[]` (the high-bar empty default). Present-but-not-an-array, or
 * an element that is not an object, is malformed -> throw. Element-level field
 * validation is intentionally left to the engine, which already defends against
 * missing `sourceRecordId` / empty claim text downstream.
 */
function coerceArray<T>(value: unknown, key: string): T[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`consolidation runner: "${key}" must be an array, got ${typeof value}`);
  }
  for (const item of value) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`consolidation runner: "${key}" contains a non-object element`);
    }
  }
  return value as T[];
}

/**
 * Pull the JSON object out of the model's text: strip a surrounding ```json fence,
 * then (if there is leading/trailing prose) slice from the first `{` to the last
 * `}`. Returns null when no object-looking span exists.
 */
export function extractJsonObject(text: string): string | null {
  const unfenced = stripCodeFences(text).trim();
  if (!unfenced) return null;
  if (unfenced.startsWith("{") && unfenced.endsWith("}")) return unfenced;
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  return unfenced.slice(start, end + 1);
}

/** Strip a single surrounding ```json … ``` (or bare ``` … ```) code fence. */
function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

/**
 * Default subprocess: a one-shot `claude -p … --output-format json` run. The json
 * envelope carries the model's final text in `.result`. A timeout guard (rule 12)
 * SIGINTs the whole process tree on expiry, which closes stdout and unblocks the
 * read; we then surface a clear timeout error.
 */
async function defaultRunText(req: { prompt: string; timeoutMs: number; model?: string }): Promise<string> {
  const args = ["-p", req.prompt, "--output-format", "json"];
  if (req.model) args.push("--model", req.model);

  const proc = Bun.spawn(["claude", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    detached: true,
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    signalProcessTree(proc.pid, "SIGINT");
  }, req.timeoutMs);

  try {
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (timedOut) {
      throw new Error(`consolidation runner: claude timed out after ${req.timeoutMs}ms`);
    }
    if (exitCode !== 0) {
      let stderr = "";
      try {
        stderr = (await new Response(proc.stderr).text()).trim();
      } catch {
        // best-effort stderr capture
      }
      throw new Error(`consolidation runner: claude exited ${exitCode}${stderr ? `: ${stderr}` : ""}`);
    }
    return extractAssistantText(stdout);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pull the assistant's final text out of `--output-format json` stdout. The
 * envelope is `{ "type": "result", "result": "…", … }`; fall back to raw stdout
 * if it is not the expected shape (the JSON parser downstream still gets a chance).
 */
function extractAssistantText(stdout: string): string {
  const trimmed = stdout.trim();
  try {
    const envelope = JSON.parse(trimmed);
    if (envelope && typeof envelope === "object" && typeof (envelope as { result?: unknown }).result === "string") {
      return (envelope as { result: string }).result;
    }
  } catch {
    // Not the json envelope — hand the raw text to the consolidation parser.
  }
  return trimmed;
}
