import { describe, expect, it } from "bun:test";
import { runBoundedGitHubCommand } from "./cli.ts";

const bunProgram = process.execPath;

describe("runBoundedGitHubCommand", () => {
  it("drains a large response incrementally and terminates once it crosses the cap", async () => {
    const result = await runBoundedGitHubCommand([
      "-e",
      "process.stdout.write('x'.repeat(200000)); setInterval(() => {}, 1000)",
    ], {
      env: process.env as Record<string, string>,
      program: bunProgram,
      maxResponseBytes: 1024,
      timeoutMs: 2_000,
    });

    expect(result.outputExceeded).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(new TextEncoder().encode(result.stdout).byteLength).toBeLessThanOrEqual(1024);
  });

  it("bounds stderr separately and cleans up a stalled command", async () => {
    const result = await runBoundedGitHubCommand([
      "-e",
      "process.stderr.write('e'.repeat(200000)); setInterval(() => {}, 1000)",
    ], {
      env: process.env as Record<string, string>,
      program: bunProgram,
      maxErrorBytes: 1024,
      timeoutMs: 2_000,
    });

    expect(result.outputExceeded).toBe(true);
    expect(new TextEncoder().encode(result.stderr).byteLength).toBeLessThanOrEqual(1024);
  });

  it("terminates a command that does not finish before its deadline", async () => {
    const result = await runBoundedGitHubCommand([
      "-e",
      "setInterval(() => {}, 1000)",
    ], {
      env: process.env as Record<string, string>,
      program: bunProgram,
      timeoutMs: 25,
    });

    expect(result.timedOut).toBe(true);
    expect(result.outputExceeded).toBe(false);
  });
});
