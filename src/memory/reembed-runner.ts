// Isolated runner for the untrusted retrieval-text corpus. This is deliberately
// separate from the normal runner providers: this task needs a no-authority,
// one-shot text transform, not a repository-aware coding agent.

import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { signalProcessTree } from "../lifecycle/process-tree.ts";

export const DEFAULT_COMPOSER_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_COMPOSER_EFFORT = "low";

/**
 * Build an invocation that has no durable conversation, user/project config,
 * exec rules, project workspace, writable filesystem authority, or MCP setup.
 * The trailing `-` reads the untrusted corpus prompt on stdin, never argv.
 */
export function buildIsolatedComposerArgs(
  model: string,
  outFile: string,
): string[] {
  return [
    // Global Codex flag: keep a headless transform from waiting on approval.
    // The following read-only sandbox still denies all writes.
    "--ask-for-approval",
    "never",
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "-s",
    "read-only",
    "--color",
    "never",
    "-m",
    model,
    "-c",
    `model_reasoning_effort=\"${DEFAULT_COMPOSER_EFFORT}\"`,
    "-o",
    outFile,
    "-",
  ];
}

function isolatedEnvironment(): Record<string, string> {
  const path = process.env.PATH;
  if (!path) throw new Error("re-embed runner: PATH is required");
  // Do not leak application tokens or configuration to model-invoked commands.
  // Codex still resolves its own authentication from CODEX_HOME when explicitly
  // configured; --ignore-user-config prevents it from loading config.toml.
  return {
    PATH: path,
    ...(process.env.CODEX_HOME ? { CODEX_HOME: process.env.CODEX_HOME } : {}),
  };
}

export interface IsolatedComposerRequest {
  prompt: string;
  model: string;
  timeoutMs?: number;
}

/**
 * Run a retrieval rewrite in a new empty temporary directory. The model can
 * only receive the supplied stdin and return a final message; it gets no repo
 * files, rules/hooks, configured MCP servers, or application environment.
 */
export async function runIsolatedComposerText(
  request: IsolatedComposerRequest,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "junior-reembed-codex-"));
  const outFile = join(root, `${randomUUID()}.txt`);
  try {
    const proc = Bun.spawn(
      ["codex", ...buildIsolatedComposerArgs(request.model, outFile)],
      {
        cwd: root,
        env: isolatedEnvironment(),
        stdin: new TextEncoder().encode(request.prompt),
        stdout: "ignore",
        stderr: "pipe",
        detached: true,
      },
    );
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      signalProcessTree(proc.pid, "SIGINT");
    }, request.timeoutMs ?? DEFAULT_COMPOSER_TIMEOUT_MS);
    try {
      const exitCode = await proc.exited;
      if (timedOut) {
        throw new Error(
          `re-embed runner: codex timed out after ${request.timeoutMs ?? DEFAULT_COMPOSER_TIMEOUT_MS}ms`,
        );
      }
      if (exitCode !== 0) {
        const stderr = (await new Response(proc.stderr).text()).trim();
        throw new Error(
          `re-embed runner: codex exited ${exitCode}${stderr ? `: ${stderr}` : ""}`,
        );
      }
      const text = await readFile(outFile, "utf8");
      if (!text.trim()) {
        throw new Error("re-embed runner: codex produced an empty output file");
      }
      return text;
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
