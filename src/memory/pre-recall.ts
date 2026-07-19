// Pre-recall hook: runs BEFORE the runner spawns to inject operational memory
// into the prompt. A cheap one-shot LLM extracts 0-3 recall queries from the
// raw Slack message, then each query hits recallMemory() from the MCP server.
// Results are formatted as a <pre-recall> XML block prepended to the prompt.
//
// The LLM call is a CLI subprocess (CLAUDE.md rule 1), not an SDK call. Same
// timeout + process-tree SIGINT pattern as the consolidation runner. The module
// exports a factory function returning a closure (CLAUDE.md rule 14).

import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFile, rm } from "node:fs/promises";

import type { Config } from "../config.ts";
import type { MemoryToolDeps, RecallMemoryResult } from "../mcp/slack-server.ts";
import { recallMemory } from "../mcp/slack-server.ts";
import { createMemoryStore } from "./factory.ts";
import { createProfileStore } from "./profiles/index.ts";
import {
  isProcessTreeAlive,
  terminateProcessTree,
} from "../lifecycle/process-tree.ts";
import { sanitizeClaudeModel } from "./consolidation/runner.ts";
import { createOpenCodeStreamParser, createOpenCodeEventMapper } from "../opencode/parser.ts";
import { log as _log } from "../logger.ts";

// ── Runner type (same as ConsolidationRunner) ────────────────────────────────
export type PreRecallRunner = "claude" | "opencode" | "codex";

// ── Pinned cheapest models per runner ────────────────────────────────────────
const DEFAULT_CLAUDE_MODEL = "claude-haiku-4-5-20251001";
const DEFAULT_OPENCODE_MODEL = "opencode-go/deepseek-v4-pro";
const DEFAULT_CODEX_MODEL = "gpt-5.4-nano";

// ── Extraction system prompt ─────────────────────────────────────────────────
const EXTRACTION_SYSTEM_PROMPT = `You analyze incoming Slack messages and extract what should be recalled from long-term memory before processing.

Given a message, identify 0-3 recall queries — systems, APIs, procedures, people, or domain concepts mentioned that prior operational knowledge might help with.

Return ONLY a JSON array of query strings. Return [] if nothing worth recalling.

Examples:
- "shift simran's ticket from bangalore to delhi" → ["event registration city shift procedure", "admin API event registration"]
- "can you review PR #45 on gx-backend" → ["gx-backend review conventions"]
- "hey what's up" → []
- "use the admin api to approve it" → ["admin API event registration approve"]
- "onboard rahul, phone 9876543210, email rahul@test.com" → ["member onboarding procedure"]`;

// ── Public types ─────────────────────────────────────────────────────────────
export interface PreRecallOptions {
  /**
   * Session target repo (RepoConfig.name). Scopes recall so another repo's
   * conventions or operational data can't inject into this session's prompt.
   * Null/undefined recalls across the whole corpus (repo-less sessions).
   */
  repo?: string | null;
}

export type PreRecallFn = (
  message: string,
  options?: PreRecallOptions,
) => Promise<string | null>;

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a pre-recall function that lazily initializes memory dependencies and
 * returns a closure. The closure extracts recall queries from a raw Slack
 * message via a cheap LLM call, runs them through recallMemory(), and returns
 * a formatted <pre-recall> block or null.
 */
export function createPreRecall(config: Config): PreRecallFn {
  const preRecallConfig = config.memory.preRecall;
  if (!preRecallConfig?.enabled) {
    return async () => null;
  }

  const runner = preRecallConfig.runner;
  const model = preRecallConfig.model ?? defaultModelForRunner(runner);
  const timeoutMs = preRecallConfig.timeoutMs;

  // Lazy singleton deps for recallMemory()
  let deps: MemoryToolDeps | null = null;

  async function getDeps(): Promise<MemoryToolDeps> {
    if (deps) return deps;

    const store = createMemoryStore(config.memory.sqlitePath);
    const { createEmbeddingProvider } = await import("./embedding/factory.ts");
    const provider = createEmbeddingProvider(
      config.memory.embedProvider ?? "local",
    );
    const profileStore = createProfileStore();
    deps = { store, provider, profileStore };
    return deps;
  }

  return async (
    message: string,
    options?: PreRecallOptions,
  ): Promise<string | null> => {
    try {
      // Step 1: Extract recall queries via cheap LLM
      const queries = await extractRecallQueries(message, runner, model, timeoutMs);
      if (queries.length === 0) return null;

      // Step 2: Run each query through recallMemory(), scoped to the session's
      // repo when one is set.
      const memDeps = await getDeps();
      const seenClaimIds = new Set<string>();
      const allClaims: RecallMemoryResult["claims"] = [];

      for (const query of queries) {
        const result = await recallMemory(
          {
            query,
            limit: 3,
            // "This repo or global, never other repos" — a strict repo filter
            // would drop the repo-less lessons that make up most of the corpus.
            repo: options?.repo ?? undefined,
            repoIncludeGlobal: true,
          },
          memDeps,
        );
        for (const claim of result.claims) {
          if (seenClaimIds.has(claim.id)) continue;
          seenClaimIds.add(claim.id);
          allClaims.push(claim);
        }
      }

      if (allClaims.length === 0) return null;

      // Step 3: Format as <pre-recall> block
      const claimLines = allClaims.map((c) => `- ${c.text}`).join("\n");
      return [
        "<pre-recall>",
        "The following operational knowledge was automatically recalled from memory. Use as context.",
        "",
        claimLines,
        "</pre-recall>",
      ].join("\n");
    } catch (err) {
      _log.warn(
        "pre-recall",
        `fail err=${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  };
}

// ── Query extraction ─────────────────────────────────────────────────────────

/**
 * Spawn a cheap one-shot LLM to extract recall queries from the raw message.
 * Returns 0-3 query strings. On timeout, error, or malformed output, returns [].
 */
async function extractRecallQueries(
  message: string,
  runner: PreRecallRunner,
  model: string,
  timeoutMs: number,
): Promise<string[]> {
  const runText = runTextForRunner(runner);
  const raw = await runText({ message, model, timeoutMs });
  return parseQueryArray(raw);
}

/**
 * Parse the LLM's response as a JSON array of strings. Returns [] on any
 * parse failure — never throws.
 */
function parseQueryArray(raw: string): string[] {
  const trimmed = raw.trim();
  // Strip code fences if present
  const unfenced = trimmed.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();

  try {
    const parsed = JSON.parse(unfenced);
    if (!Array.isArray(parsed)) return [];
    const queries = parsed
      .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      .slice(0, 3);
    return queries;
  } catch {
    return [];
  }
}

// ── Per-runner subprocess functions ──────────────────────────────────────────

interface RunTextRequest {
  message: string;
  model: string;
  timeoutMs: number;
}

type RunTextFn = (req: RunTextRequest) => Promise<string>;

function defaultModelForRunner(runner: PreRecallRunner): string {
  if (runner === "opencode") return DEFAULT_OPENCODE_MODEL;
  if (runner === "codex") return DEFAULT_CODEX_MODEL;
  return DEFAULT_CLAUDE_MODEL;
}

function runTextForRunner(runner: PreRecallRunner): RunTextFn {
  if (runner === "opencode") return openCodeRunText;
  if (runner === "codex") return codexRunText;
  return claudeRunText;
}

// ── Claude subprocess ────────────────────────────────────────────────────────

/**
 * Locked down like the untrusted-content extraction runners: the input is a
 * raw Slack message, so the subprocess gets NO tools, NO MCP servers, NO
 * user/project hooks (a user-level Stop hook otherwise replaces the -p JSON
 * envelope's `result` with the hook reply). The message rides stdin, not argv
 * (E2BIG on long messages). Exported for tests.
 */
export function buildPreRecallClaudeArgs(model: string): string[] {
  return [
    "-p",
    "--system-prompt", EXTRACTION_SYSTEM_PROMPT,
    "--output-format", "json",
    "--model", sanitizeClaudeModel(model),
    "--tools", "",
    "--strict-mcp-config",
    "--settings", '{"disableAllHooks":true}',
  ];
}

async function claudeRunText(req: RunTextRequest): Promise<string> {
  // Neutral cwd outside the repo so the run can't inherit junior's CLAUDE.md /
  // .claude/ / .mcp.json context.
  const args = buildPreRecallClaudeArgs(req.model);

  const proc = Bun.spawn(["claude", ...args], {
    cwd: tmpdir(),
    stdout: "pipe",
    stderr: "pipe",
    stdin: new TextEncoder().encode(req.message),
    detached: true,
  });

  return runPreRecallProcess(proc, req.timeoutMs, "claude", extractClaudeAssistantText);
}

/**
 * Pull the assistant's final text out of `--output-format json` stdout.
 * The envelope is `{ "type": "result", "result": "...", ... }`.
 */
function extractClaudeAssistantText(stdout: string): string {
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
    // Not the json envelope — return raw
  }
  return trimmed;
}

// ── OpenCode subprocess ──────────────────────────────────────────────────────

async function openCodeRunText(req: RunTextRequest): Promise<string> {
  // OpenCode does not support --system-prompt, so bake the system prompt
  // into the user prompt.
  const combinedPrompt = `${EXTRACTION_SYSTEM_PROMPT}\n\n---\n\nMessage:\n${req.message}`;
  const args = ["run", "--format", "json"];
  if (req.model) args.push("--model", req.model);
  args.push(combinedPrompt);

  // Same lockdown intent as the claude branch: neutral cwd outside the repo
  // (no junior project config/MCP discovery), an inline config that denies
  // every tool (the extractor only needs text-in/text-out), and no
  // OPENCODE_CONFIG env layer from the developer shell.
  const env: Record<string, string | undefined> = {
    ...process.env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: { "*": "deny" } }),
  };
  delete env.OPENCODE_CONFIG;

  const proc = Bun.spawn(["opencode", ...args], {
    cwd: tmpdir(),
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    detached: true,
  });

  return runPreRecallProcess(proc, req.timeoutMs, "opencode", extractOpenCodeAssistantText);
}

/**
 * Extract the final assistant text from OpenCode's `--format json` NDJSON
 * stdout using the production stream parser.
 */
function extractOpenCodeAssistantText(stdout: string): string {
  const parser = createOpenCodeStreamParser();
  const mapper = createOpenCodeEventMapper();
  for (const event of parser.feed(stdout)) mapper.map(event);
  for (const event of parser.flush()) mapper.map(event);
  return mapper.response || stdout.trim();
}

// ── Codex subprocess ─────────────────────────────────────────────────────────

async function codexRunText(req: RunTextRequest): Promise<string> {
  const outFile = join(tmpdir(), `junior-pre-recall-codex-${crypto.randomUUID()}.txt`);
  // Bake system prompt into stdin since codex exec has no --system-prompt flag.
  const combinedPrompt = `${EXTRACTION_SYSTEM_PROMPT}\n\n---\n\nMessage:\n${req.message}`;

  const args = [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "-s", "read-only",
    "--color", "never",
    "-m", req.model,
    "-o", outFile,
    "-",
  ];

  const proc = Bun.spawn(["codex", ...args], {
    cwd: tmpdir(),
    stdin: new TextEncoder().encode(combinedPrompt),
    stdout: "ignore",
    stderr: "pipe",
    detached: true,
  });

  try {
    const exitCode = await runPreRecallExited(proc, req.timeoutMs, "codex");
    if (exitCode !== 0) {
      let stderr = "";
      try {
        stderr = (await new Response(proc.stderr).text()).trim();
      } catch {
        // best-effort
      }
      throw new Error(`pre-recall: codex exited ${exitCode}${stderr ? `: ${stderr}` : ""}`);
    }
    let text: string;
    try {
      text = await readFile(outFile, "utf8");
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`pre-recall: codex output file unreadable (${reason})`);
    }
    if (!text.trim()) {
      throw new Error("pre-recall: codex produced an empty output file");
    }
    return text;
  } finally {
    await rm(outFile, { force: true }).catch(() => {});
  }
}

/**
 * Await process exit with a hard deadline. On timeout, SIGINT then SIGKILL the
 * process tree so a hung child cannot leave the Slack turn stuck forever.
 */
type PreRecallProc = {
  pid?: number | null;
  exited: Promise<number>;
  stdout?: ReadableStream<Uint8Array> | number | null;
  stderr?: ReadableStream<Uint8Array> | number | null;
};

async function runPreRecallExited(
  proc: PreRecallProc,
  timeoutMs: number,
  label: string,
): Promise<number> {
  let timedOut = false;
  const forceMs = Math.min(2_000, Math.max(500, Math.floor(timeoutMs / 4)));
  const timer = setTimeout(() => {
    timedOut = true;
    void terminateProcessTree(proc.pid, {
      signal: "SIGINT",
      forceAfterMs: forceMs,
      waitAfterForceMs: 500,
    });
  }, timeoutMs);

  try {
    // Hard ceiling: if SIGKILL also fails to reap, don't hang the turn.
    const hardDeadlineMs = timeoutMs + forceMs + 2_000;
    const exitCode = await Promise.race([
      proc.exited,
      sleep(hardDeadlineMs).then(async () => {
        timedOut = true;
        await terminateProcessTree(proc.pid, {
          signal: "SIGKILL",
          forceAfterMs: 0,
          waitAfterForceMs: 200,
        });
        throw new Error(
          `pre-recall: ${label} hung after ${hardDeadlineMs}ms (forced kill)`,
        );
      }),
    ]);
    if (timedOut) {
      throw new Error(`pre-recall: ${label} timed out after ${timeoutMs}ms`);
    }
    return exitCode;
  } finally {
    clearTimeout(timer);
    if (isProcessTreeAlive(proc.pid)) {
      await terminateProcessTree(proc.pid, {
        signal: "SIGKILL",
        forceAfterMs: 0,
        waitAfterForceMs: 200,
      });
    }
  }
}

async function runPreRecallProcess(
  proc: PreRecallProc,
  timeoutMs: number,
  label: string,
  extract: (stdout: string) => string,
): Promise<string> {
  try {
    // Start reading stdout immediately so the pipe cannot fill and stall.
    const stdoutStream = proc.stdout;
    const stdoutPromise =
      stdoutStream && typeof stdoutStream !== "number"
        ? new Response(stdoutStream).text()
        : Promise.resolve("");
    const exitCode = await runPreRecallExited(proc, timeoutMs, label);
    const stdout = await stdoutPromise;
    if (exitCode !== 0) {
      let stderr = "";
      try {
        const stderrStream = proc.stderr;
        if (stderrStream && typeof stderrStream !== "number") {
          stderr = (await new Response(stderrStream).text()).trim();
        }
      } catch {
        // best-effort
      }
      throw new Error(
        `pre-recall: ${label} exited ${exitCode}${stderr ? `: ${stderr}` : ""}`,
      );
    }
    return extract(stdout);
  } catch (err) {
    if (isProcessTreeAlive(proc.pid)) {
      await terminateProcessTree(proc.pid, {
        signal: "SIGKILL",
        forceAfterMs: 0,
        waitAfterForceMs: 200,
      });
    }
    throw err;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
