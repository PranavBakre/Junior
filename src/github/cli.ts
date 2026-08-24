import { terminateProcessTree } from "../lifecycle/process-tree.ts";

export const MAX_GITHUB_RESPONSE_BYTES = 512 * 1024;
export const MAX_GITHUB_ERROR_BYTES = 64 * 1024;
export const DEFAULT_GITHUB_COMMAND_TIMEOUT_MS = 30_000;

export interface BoundedGitHubCommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputExceeded: boolean;
}

export interface BoundedGitHubCommandOptions {
  env: Record<string, string>;
  input?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxErrorBytes?: number;
  /** Test-only override; production always invokes `gh`. */
  program?: string;
}

/**
 * Execute a gh command without allowing a verbose response, blocked pipe, or
 * surviving descendant to consume Junior indefinitely. Successful stdout is
 * retained only up to its response cap; stderr keeps a bounded diagnostic tail.
 */
export async function runBoundedGitHubCommand(
  args: string[],
  options: BoundedGitHubCommandOptions,
): Promise<BoundedGitHubCommandResult> {
  const responseLimit = options.maxResponseBytes ?? MAX_GITHUB_RESPONSE_BYTES;
  const errorLimit = options.maxErrorBytes ?? MAX_GITHUB_ERROR_BYTES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_GITHUB_COMMAND_TIMEOUT_MS;
  const proc = Bun.spawn([options.program ?? "gh", ...args], {
    env: options.env,
    stdin: options.input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  });
  if (options.input !== undefined && proc.stdin) {
    proc.stdin.write(options.input);
    proc.stdin.end();
  }

  let resolveLimit: (() => void) | undefined;
  const outputLimit = new Promise<"output_limit">((resolve) => {
    resolveLimit = () => resolve("output_limit");
  });
  const stdout = drain(proc.stdout, responseLimit, "prefix", () => resolveLimit?.());
  const stderr = drain(proc.stderr, errorLimit, "tail", () => resolveLimit?.());
  const completed = Promise.all([proc.exited, stdout.done, stderr.done]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });

  try {
    const outcome = await Promise.race([completed, outputLimit, timeout]);
    if (outcome === "timeout" || outcome === "output_limit") {
      await terminateProcessTree(proc.pid, {
        signal: "SIGTERM",
        forceAfterMs: 1_000,
        waitAfterForceMs: 1_000,
      });
      stdout.cancel();
      stderr.cancel();
      return {
        status: null,
        stdout: stdout.text(),
        stderr: stderr.text(),
        timedOut: outcome === "timeout",
        outputExceeded: outcome === "output_limit",
      };
    }
    return {
      status: outcome[0],
      stdout: stdout.text(),
      stderr: stderr.text(),
      timedOut: false,
      outputExceeded: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

function drain(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  mode: "prefix" | "tail",
  onLimit: () => void,
): { done: Promise<void>; text: () => string; cancel: () => void } {
  const reader = stream.getReader();
  let bytes = 0;
  let chunks: Uint8Array[] = [];
  let exceeded = false;
  const append = (chunk: Uint8Array): void => {
    if (exceeded) return;
    const remaining = maxBytes - bytes;
    if (remaining <= 0) {
      exceeded = true;
      onLimit();
      return;
    }
    const accepted = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
    if (mode === "prefix") {
      chunks.push(accepted.slice());
    } else {
      chunks = [joinBytes(chunks, accepted, maxBytes)].filter((value) => value.byteLength > 0);
    }
    bytes += accepted.byteLength;
    if (accepted.byteLength !== chunk.byteLength) {
      exceeded = true;
      onLimit();
    }
  };
  const done = (async () => {
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        append(next.value);
        if (exceeded) break;
      }
    } catch {
      // Cancellation after a limit or timeout retains the bounded partial text.
    }
  })();
  return {
    done,
    text: () => new TextDecoder().decode(joinBytes(chunks)),
    cancel: () => { void reader.cancel().catch(() => undefined); },
  };
}

function joinBytes(
  chunks: Uint8Array[],
  extra?: Uint8Array,
  tailLimit?: number,
): Uint8Array {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0) +
    (extra?.byteLength ?? 0);
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (extra) all.set(extra, offset);
  return tailLimit !== undefined && all.byteLength > tailLimit
    ? all.subarray(all.byteLength - tailLimit)
    : all;
}
