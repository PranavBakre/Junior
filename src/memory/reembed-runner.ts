// No-authority runner for the untrusted retrieval-text corpus.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { terminateProcessTree } from "../lifecycle/process-tree.ts";

export const DEFAULT_COMPOSER_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_COMPOSER_MODEL = "claude-opus-5";
export const MAX_COMPOSER_STDOUT_BYTES = 512 * 1024;
export const MAX_COMPOSER_STDERR_BYTES = 64 * 1024;

export const composerOutputSchema = {
  type: "object",
  properties: {
    rewrites: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        properties: {
          id: { type: "string", maxLength: 512 },
          retrievalText: { type: "string", maxLength: 2_500 },
        },
        required: ["id", "retrievalText"],
        additionalProperties: false,
      },
    },
  },
  required: ["rewrites"],
  additionalProperties: false,
} as const;

/**
 * Claude's `--tools ""` is an explicit empty built-in-tool allowlist. Safe mode
 * disables hooks, rules, skills, plugins, configured MCP servers, and project
 * discovery; no command-capable agent surface remains.
 */
export function buildNoToolsComposerArgs(model: string): string[] {
  return [
    "--safe-mode",
    "-p",
    "--tools", "",
    "--setting-sources", "",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--output-format", "json",
    "--json-schema", JSON.stringify(composerOutputSchema),
    "--model", model,
    "--max-budget-usd", "0.25",
  ];
}

/** Keep only runtime and Claude authentication variables; model tools are off. */
export function sterileComposerEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const path = env.PATH;
  const home = env.HOME;
  if (!path || !home) throw new Error("re-embed runner: PATH and HOME are required");
  return {
    PATH: path,
    HOME: home,
    ...(env.USER ? { USER: env.USER } : {}),
    ...(env.LOGNAME ? { LOGNAME: env.LOGNAME } : {}),
    ...(env.SHELL ? { SHELL: env.SHELL } : {}),
    ...(env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY } : {}),
    ...(env.ANTHROPIC_BASE_URL ? { ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL } : {}),
  };
}

export interface IsolatedComposerRequest {
  prompt: string;
  model?: string;
  timeoutMs?: number;
  /** Test seam for an executable that behaves like the Claude CLI. */
  command?: string;
}

export function armComposerTimeout(
  proc: { pid?: number | null },
  timeoutMs: number,
): { didTimeout: () => boolean; clear: () => void } {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void terminateProcessTree(proc.pid, {
      signal: "SIGINT",
      forceAfterMs: 5_000,
      waitAfterForceMs: 1_000,
    });
  }, timeoutMs);
  return { didTimeout: () => timedOut, clear: () => clearTimeout(timer) };
}

export async function readBoundedComposerStream(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  label: string,
): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw new Error(`re-embed runner: ${label} exceeds ${maxBytes} bytes`);
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output);
}

/** Decode Claude's bounded JSON envelope, not arbitrary model prose. */
export function parseNoToolsComposerOutput(text: string): Array<{ id: string; retrievalText: string }> {
  const envelope = JSON.parse(text) as {
    is_error?: unknown;
    result?: unknown;
    structured_output?: unknown;
  };
  if (envelope.is_error === true) {
    throw new Error(`re-embed runner: Claude failed: ${typeof envelope.result === "string" ? envelope.result : "unknown error"}`);
  }
  if (!envelope.structured_output || typeof envelope.structured_output !== "object") {
    throw new Error("re-embed runner: Claude returned no structured output");
  }
  const value = envelope.structured_output as { rewrites?: unknown };
  if (!Array.isArray(value.rewrites) || value.rewrites.length > 100) {
    throw new Error("re-embed runner: invalid or oversized rewrite array");
  }
  return value.rewrites.map((item) => {
    if (!item || typeof item !== "object") throw new Error("re-embed runner: invalid rewrite entry");
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.retrievalText !== "string") {
      throw new Error("re-embed runner: invalid rewrite entry");
    }
    return { id: record.id, retrievalText: record.retrievalText };
  });
}

/**
 * A one-shot, no-tool transform. If the installed Claude CLI loses support for
 * its empty tool allowlist, the command fails instead of falling back to an
 * ambient coding agent.
 */
export async function runNoToolsComposer(
  request: IsolatedComposerRequest,
): Promise<Array<{ id: string; retrievalText: string }>> {
  const root = await mkdtemp(join(tmpdir(), "junior-reembed-claude-"));
  try {
    const proc = Bun.spawn(
      [request.command ?? "claude", ...buildNoToolsComposerArgs(request.model ?? DEFAULT_COMPOSER_MODEL)],
      {
        cwd: root,
        env: sterileComposerEnvironment(),
        stdout: "pipe",
        stderr: "pipe",
        stdin: new TextEncoder().encode(request.prompt),
        detached: true,
      },
    );
    const timeoutMs = request.timeoutMs ?? DEFAULT_COMPOSER_TIMEOUT_MS;
    const timeout = armComposerTimeout(proc, timeoutMs);
    try {
      let stdout: string;
      let stderr: string;
      let exitCode: number;
      try {
        [stdout, stderr, exitCode] = await Promise.all([
          readBoundedComposerStream(proc.stdout, MAX_COMPOSER_STDOUT_BYTES, "stdout"),
          readBoundedComposerStream(proc.stderr, MAX_COMPOSER_STDERR_BYTES, "stderr"),
          proc.exited,
        ]);
      } catch (error) {
        await terminateProcessTree(proc.pid, {
          signal: "SIGINT",
          forceAfterMs: 5_000,
          waitAfterForceMs: 1_000,
        });
        throw error;
      }
      if (timeout.didTimeout()) throw new Error(`re-embed runner: Claude timed out after ${timeoutMs}ms`);
      if (exitCode !== 0) throw new Error(`re-embed runner: Claude exited ${exitCode}${stderr.trim() ? `: ${stderr.trim()}` : ""}`);
      return parseNoToolsComposerOutput(stdout);
    } finally {
      timeout.clear();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
