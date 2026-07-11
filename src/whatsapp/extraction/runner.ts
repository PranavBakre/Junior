// Default extraction runner (whatsapp-hermes-tracker §extraction sweep).
//
// The sweep takes an injected `ExtractionRunner` (prompt -> raw model text) so
// tests never spawn a CLI. This is the production runner behind that contract:
// a one-shot `claude -p … --output-format json` subprocess (CLAUDE.md rule 1:
// CLI subprocess, not SDK), mirroring memory consolidation's `defaultRunText`
// timeout/output-extraction pattern but feeding the prompt on STDIN (as the
// codex consolidation runner does) so a large batch can't hit the argv limit.
// We reuse the consolidation module's
// generic `sanitizeClaudeModel` helper (its `defaultRunText` is private and its
// public invoke is coupled to consolidation's own schema, so the spawn body is
// mirrored, not imported). JSON extraction/validation lives in the sweep's
// parser, not here — this runner just returns the model's final assistant text.

import { mkdirSync } from "node:fs";

import { signalProcessTree } from "../../lifecycle/process-tree.ts";
import { sanitizeClaudeModel } from "../../memory/consolidation/runner.ts";

/** prompt -> raw model text. Injected into the sweep; the default spawns claude. */
export type ExtractionRunner = (prompt: string) => Promise<string>;

/** Per-run timeout guard (CLAUDE.md rule 12). 5 minutes. */
export const DEFAULT_EXTRACTION_TIMEOUT_MS = 5 * 60_000;

/** Pinned model — never leave `--model` unset (CLI-default drift). */
export const DEFAULT_EXTRACTION_MODEL = "claude-opus-4-6";

/**
 * Default neutral working directory for the extraction subprocess. Isolating the
 * cwd here (rather than junior's repo root) keeps the untrusted-content run from
 * inheriting junior's CLAUDE.md / `.claude/` settings / `.mcp.json` project
 * context. Created on demand; a sibling of the WhatsApp data dir in production.
 */
export const DEFAULT_EXTRACTION_SANDBOX_DIR = "data/whatsapp-extraction-sandbox";

export interface ExtractionRunnerOptions {
  /** Timeout guard in ms (default 5 min). SIGINTs the subprocess tree on expiry. */
  timeoutMs?: number;
  /** Model override. Defaults to the pinned extraction model. */
  model?: string;
  /**
   * Neutral cwd for the subprocess (defaults to `DEFAULT_EXTRACTION_SANDBOX_DIR`).
   * Created on demand. Must NOT be junior's repo root — see the security note on
   * `buildExtractionArgs`.
   */
  sandboxDir?: string;
}

/**
 * Build the `claude` argv for an extraction run. Exported for unit testing the
 * exact lockdown flags, since the spawned subprocess embeds UNTRUSTED WhatsApp
 * group messages in its prompt — a participant could try to prompt-inject tool
 * use to read/exec on the host and exfiltrate the result into task output. The
 * flags neutralize that:
 *
 * - `--tools ""` disables ALL built-in tools (the CLI's strongest no-tools
 *   switch on this version — see `claude --help`: `Use "" to disable all
 *   tools`). No Bash/Read/Write/Edit/WebFetch/Task/etc. can run, so an injected
 *   instruction has nothing to act with.
 * - `--strict-mcp-config` with no `--mcp-config` loads zero MCP servers, closing
 *   the MCP-tool vector too.
 * - `--settings '{"disableAllHooks":true}'` blocks USER-level (~/.claude) hooks,
 *   which the neutral cwd does NOT: a user Stop hook injects a follow-up turn
 *   and the hook-reply becomes the envelope's `result`, replacing the model's
 *   JSON (observed live: every sweep returned the learnings-hook's "No durable
 *   lesson…" prose and parse-failed).
 *
 * Paired at spawn time with a neutral cwd (so no project CLAUDE.md / `.claude/`
 * settings / `.mcp.json` are inherited) this makes the run text-in / text-out
 * with no capability to touch the host.
 */
export function buildExtractionArgs(model: string): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--model",
    model,
    // Untrusted-content lockdown (defense in depth). See the doc comment above.
    "--tools",
    "", // disable ALL built-in tools
    "--strict-mcp-config", // no --mcp-config -> zero MCP servers load
    "--settings",
    '{"disableAllHooks":true}', // user hooks would hijack the final message
  ];
}

/**
 * Build the production `ExtractionRunner`. The model is always pinned so the run
 * never drifts onto an unpinned CLI default. On timeout / non-zero exit it
 * throws a clear error; the sweep treats that as "leave this group's messages
 * unprocessed and retry next tick", never a crash.
 */
export function createClaudeExtractionRunner(
  opts: ExtractionRunnerOptions = {},
): ExtractionRunner {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_EXTRACTION_TIMEOUT_MS;
  const model = sanitizeClaudeModel(opts.model ?? DEFAULT_EXTRACTION_MODEL);
  const sandboxDir = opts.sandboxDir ?? DEFAULT_EXTRACTION_SANDBOX_DIR;

  return async (prompt: string): Promise<string> => {
    // Neutral, empty cwd (created on demand) so the subprocess doesn't inherit
    // junior's CLAUDE.md / `.claude/` settings / `.mcp.json` project context —
    // the run embeds untrusted group messages (see `buildExtractionArgs`).
    mkdirSync(sandboxDir, { recursive: true });

    // Prompt goes in on STDIN, never as an argv element: a large per-group batch
    // can blow past the OS argv limit (E2BIG), and `Bun.spawn` surfacing E2BIG
    // would make the sweep retry the identical oversized prompt forever. `claude
    // -p` with no positional prompt reads it from stdin (same pattern the codex
    // consolidation runner uses). Bun.spawn accepts the encoded bytes directly.
    const proc = Bun.spawn(["claude", ...buildExtractionArgs(model)], {
      cwd: sandboxDir,
      stdout: "pipe",
      stderr: "pipe",
      stdin: new TextEncoder().encode(prompt),
      detached: true,
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      signalProcessTree(proc.pid, "SIGINT");
    }, timeoutMs);

    try {
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      if (timedOut) {
        throw new Error(
          `extraction runner: claude timed out after ${timeoutMs}ms`,
        );
      }
      if (exitCode !== 0) {
        let stderr = "";
        try {
          stderr = (await new Response(proc.stderr).text()).trim();
        } catch {
          // best-effort stderr capture
        }
        throw new Error(
          `extraction runner: claude exited ${exitCode}${stderr ? `: ${stderr}` : ""}`,
        );
      }
      return extractAssistantText(stdout);
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Pull the assistant's final text out of `--output-format json` stdout. The
 * envelope is `{ "type": "result", "result": "…", … }`; fall back to raw stdout
 * if it is not that shape (the sweep's JSON parser still gets a chance).
 */
function extractAssistantText(stdout: string): string {
  const trimmed = stdout.trim();
  try {
    const envelope = JSON.parse(trimmed);
    if (
      envelope &&
      typeof envelope === "object" &&
      typeof (envelope as { result?: unknown }).result === "string"
    ) {
      return (envelope as { result: string }).result;
    }
  } catch {
    // Not the json envelope — hand the raw text to the sweep's parser.
  }
  return trimmed;
}
