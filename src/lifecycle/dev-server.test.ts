/**
 * Tests for DevServerManager (Scope-2a).
 *
 * Unit tests: mock-inject spawn/fetch behaviour to verify logic paths without
 *   spinning up real processes or git repos.
 * Integration tests: real-fs, real-git, real spawn — a tiny shell-script dev
 *   server that listens on a high-numbered port and exits cleanly on SIGINT.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoConfig } from "../config.ts";
import { WorktreeManager } from "../worktree/manager.ts";
import { DevServerManager, resolveReadyUrl } from "./dev-server.ts";

// ---------------------------------------------------------------------------
// Helpers shared across suites
// ---------------------------------------------------------------------------

async function spawnRun(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(args, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`${args.join(" ")} failed: ${err}`);
  }
}

/** Wait up to `timeoutMs` for `predicate()` to return true. */
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(intervalMs);
  }
  throw new Error("waitFor timed out");
}

/** Returns true if the given PID is still alive. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Integration test suite — real git repo + real shell "dev server"
// ---------------------------------------------------------------------------

describe("DevServerManager (integration)", () => {
  let repoRoot: string;
  let serverPort: number;
  let repos: RepoConfig[];
  let worktreeManager: WorktreeManager;

  // Ports in the 40000–49999 range are unlikely to be in use.
  // We pick a fixed one; if it's held the test will time out at bootstrap.
  serverPort = 41_234;

  beforeAll(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), "junior-ds-test-"));

    // Init a minimal git repo with one commit on `main`.
    await spawnRun(["git", "init", "-q", "-b", "main"], repoRoot);
    await spawnRun(
      ["git", "config", "user.email", "test@example.com"],
      repoRoot,
    );
    await spawnRun(["git", "config", "user.name", "test"], repoRoot);
    writeFileSync(join(repoRoot, "README.md"), "hello\n");
    await spawnRun(["git", "add", "."], repoRoot);
    await spawnRun(["git", "commit", "-q", "-m", "init"], repoRoot);

    // A `fix` branch for branch-change tests.
    await spawnRun(["git", "checkout", "-q", "-b", "fix/test"], repoRoot);
    writeFileSync(join(repoRoot, "FIX.md"), "fix\n");
    await spawnRun(["git", "add", "."], repoRoot);
    await spawnRun(["git", "commit", "-q", "-m", "fix"], repoRoot);
    await spawnRun(["git", "checkout", "-q", "main"], repoRoot);

    // Point origin at ourselves so git fetch works inside worktrees.
    await spawnRun(["git", "remote", "add", "origin", repoRoot], repoRoot);
    await spawnRun(["git", "fetch", "-q", "origin"], repoRoot);

    // Write a fake "dev server" using Node.js (always available alongside Bun).
    // It listens on a high port, responds HTTP 200 to every request, and exits
    // cleanly on SIGINT. No nc/socat needed — pure Node http module.
    //
    // IMPORTANT: the script must be committed to git so the worktree checkout
    // includes it. After writing, commit and re-fetch so the dev-server worktree
    // (created from origin/main) gets the script.
    const serverScript = join(repoRoot, "fake-server.js");
    writeFileSync(
      serverScript,
      `#!/usr/bin/env node
const http = require('http');
const port = parseInt(process.argv[2] || '${serverPort}', 10);
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('ok');
});
server.listen(port, '127.0.0.1');
process.on('SIGINT', () => { server.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });
`,
    );
    chmodSync(serverScript, 0o755);
    // Commit the script into git so the worktree picks it up.
    await spawnRun(["git", "add", "fake-server.js"], repoRoot);
    await spawnRun(["git", "commit", "-q", "-m", "add fake dev server"], repoRoot);
    await spawnRun(["git", "fetch", "-q", "origin"], repoRoot);

    repos = [
      {
        name: "test-repo",
        path: repoRoot,
        defaultBase: "origin/main",
        devCommand: `node fake-server.js ${serverPort}`,
        devPort: serverPort,
      },
    ];
    worktreeManager = new WorktreeManager(repos);
  });

  afterAll(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("bootstrap creates the dev-server worktree if it does not exist", async () => {
    const manager = new DevServerManager(repos, worktreeManager);
    try {
      await manager.bootstrap();

      const wtPath = worktreeManager.getWorktreePath("test-repo", "dev-server");
      expect(existsSync(wtPath)).toBe(true);
      expect(existsSync(join(wtPath, "README.md"))).toBe(true);
    } finally {
      manager.dispose();
    }
  });

  it("bootstrap is idempotent — does not fail if worktree already exists", async () => {
    const manager = new DevServerManager(repos, worktreeManager);
    try {
      // Second call after the first bootstrap already created the worktree.
      await manager.bootstrap();
      await manager.bootstrap();

      const wtPath = worktreeManager.getWorktreePath("test-repo", "dev-server");
      expect(existsSync(wtPath)).toBe(true);
    } finally {
      manager.dispose();
    }
  });

  it("status() returns undefined when no server is tracked for a repo", () => {
    const manager = new DevServerManager(repos, worktreeManager);
    try {
      expect(manager.status("test-repo")).toBeUndefined();
    } finally {
      manager.dispose();
    }
  });

  it("kill() is idempotent when nothing is tracked", async () => {
    const manager = new DevServerManager(repos, worktreeManager);
    try {
      await expect(manager.kill("test-repo")).resolves.toBeUndefined();
    } finally {
      manager.dispose();
    }
  });

  it("ensure() spawns the dev server and returns pid/port/readyUrl", async () => {
    const manager = new DevServerManager(repos, worktreeManager);
    try {
      const info = await manager.ensure("test-repo", "main");
      expect(info.pid).toBeGreaterThan(0);
      expect(info.port).toBe(serverPort);
      expect(info.readyUrl).toBe(`http://localhost:${serverPort}`);
      expect(isPidAlive(info.pid)).toBe(true);

      const state = manager.status("test-repo") as
        | import("./dev-server.ts").DevServerState
        | undefined;
      expect(state?.branch).toBe("main");
      expect(state?.pid).toBe(info.pid);
    } finally {
      await manager.killAll();
      manager.dispose();
    }
  }, 30_000);

  it("ensure() reuses a warm server when branch matches", async () => {
    const manager = new DevServerManager(repos, worktreeManager);
    try {
      const first = await manager.ensure("test-repo", "main");
      const second = await manager.ensure("test-repo", "main");

      // Same PID — no restart happened.
      expect(second.pid).toBe(first.pid);
    } finally {
      await manager.killAll();
      manager.dispose();
    }
  }, 30_000);

  it("ensure() restarts the server when branch changes", async () => {
    const manager = new DevServerManager(repos, worktreeManager);
    try {
      const first = await manager.ensure("test-repo", "main");
      const firstPid = first.pid;

      const second = await manager.ensure("test-repo", "fix/test");

      // Different PID — server was restarted.
      expect(second.pid).not.toBe(firstPid);
      // First PID should be dead.
      expect(isPidAlive(firstPid)).toBe(false);

      const state = manager.status("test-repo") as
        | import("./dev-server.ts").DevServerState
        | undefined;
      expect(state?.branch).toBe("fix/test");
    } finally {
      await manager.killAll();
      manager.dispose();
    }
  }, 60_000);

  it("kill() sends SIGINT and the process exits", async () => {
    const manager = new DevServerManager(repos, worktreeManager);
    try {
      const info = await manager.ensure("test-repo", "main");
      const pid = info.pid;
      expect(isPidAlive(pid)).toBe(true);

      await manager.kill("test-repo");

      // Process should be dead.
      await waitFor(() => !isPidAlive(pid), 8_000);
      expect(isPidAlive(pid)).toBe(false);

      // State should be cleared.
      expect(manager.status("test-repo")).toBeUndefined();
    } finally {
      await manager.killAll();
      manager.dispose();
    }
  }, 30_000);

  it("killAll() kills every tracked server", async () => {
    const manager = new DevServerManager(repos, worktreeManager);
    try {
      const info = await manager.ensure("test-repo", "main");
      const pid = info.pid;
      expect(isPidAlive(pid)).toBe(true);

      await manager.killAll();
      await waitFor(() => !isPidAlive(pid), 8_000);
      expect(isPidAlive(pid)).toBe(false);
    } finally {
      manager.dispose();
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Unit tests — verify logic paths without real processes or git repos
// ---------------------------------------------------------------------------

describe("DevServerManager (unit — logic paths)", () => {
  it("throws when repo is unknown to ensure()", async () => {
    const manager = new DevServerManager([], new WorktreeManager([]));
    try {
      await expect(manager.ensure("no-such-repo", "main")).rejects.toThrow(
        /Unknown repo/,
      );
    } finally {
      manager.dispose();
    }
  });

  it("throws when devCommand is not configured", async () => {
    const repos: RepoConfig[] = [
      { name: "bare-repo", path: "/tmp/bare", defaultBase: "main" },
    ];
    const manager = new DevServerManager(repos, new WorktreeManager(repos));
    try {
      await expect(manager.ensure("bare-repo", "main")).rejects.toThrow(
        /No devCommand/,
      );
    } finally {
      manager.dispose();
    }
  });

  it("throws when devCommand is set but neither devPort nor readyUrl is configured", async () => {
    const repos: RepoConfig[] = [
      {
        name: "misconfigured",
        path: "/tmp/misc",
        defaultBase: "main",
        devCommand: "pnpm dev",
        // no devPort, no readyUrl
      },
    ];
    const manager = new DevServerManager(repos, new WorktreeManager(repos));
    try {
      await expect(manager.ensure("misconfigured", "main")).rejects.toThrow(
        /neither devPort nor readyUrl/,
      );
    } finally {
      manager.dispose();
    }
  });

  it("resolveReadyUrl falls back to localhost:<devPort> when readyUrl is unset", () => {
    expect(
      resolveReadyUrl({
        name: "x",
        path: "/x",
        defaultBase: "origin/main",
        devPort: 41234,
      }),
    ).toBe("http://localhost:41234");
  });

  it("resolveReadyUrl prefers explicit readyUrl over devPort", () => {
    expect(
      resolveReadyUrl({
        name: "x",
        path: "/x",
        defaultBase: "origin/main",
        devPort: 41234,
        readyUrl: "https://prod-like.local:8443/health",
      }),
    ).toBe("https://prod-like.local:8443/health");
  });

  it("status() returns all states when called without repoName", () => {
    const manager = new DevServerManager([], new WorktreeManager([]));
    try {
      const all = manager.status();
      expect(all).toBeInstanceOf(Map);
      expect((all as Map<string, unknown>).size).toBe(0);
    } finally {
      manager.dispose();
    }
  });

  it("bootstrap() skips repos without devCommand", async () => {
    const repos: RepoConfig[] = [
      { name: "no-dev", path: "/tmp/no-dev", defaultBase: "main" },
    ];
    // Should complete without error even though the path doesn't exist,
    // because repos without devCommand are skipped entirely.
    const manager = new DevServerManager(repos, new WorktreeManager(repos));
    try {
      await expect(manager.bootstrap()).resolves.toBeUndefined();
    } finally {
      manager.dispose();
    }
  });

  it("kill() is idempotent — second call after first is a no-op", async () => {
    const repos: RepoConfig[] = [
      { name: "idle-repo", path: "/tmp/idle", defaultBase: "main" },
    ];
    const manager = new DevServerManager(repos, new WorktreeManager(repos));
    try {
      // Kill with nothing tracked — should not throw.
      await manager.kill("idle-repo");
      await manager.kill("idle-repo");
    } finally {
      manager.dispose();
    }
  });

  it("killAll() with no tracked servers completes without error", async () => {
    const manager = new DevServerManager([], new WorktreeManager([]));
    try {
      await expect(manager.killAll()).resolves.toBeUndefined();
    } finally {
      manager.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Unit test: idle TTL sweeper kills idle servers
// ---------------------------------------------------------------------------

describe("DevServerManager idle TTL (unit — timer injection)", () => {
  it("sweepNow() detects and kills servers whose lastUsedAt is past the TTL", async () => {
    // Real process to give us a PID to track.
    const sleepProc = Bun.spawn(["sleep", "30"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const fakePid = sleepProc.pid;
    expect(isPidAlive(fakePid)).toBe(true);

    // 1 second TTL so we don't have to fake clock arithmetic.
    const manager = new DevServerManager([], new WorktreeManager([]), {
      idleTtlMs: 1_000,
      sweepIntervalMs: 60_000,
    });
    try {
      // Plant a state entry with lastUsedAt 5 seconds in the past.
      (manager as unknown as { state: Map<string, unknown> }).state.set(
        "stale-repo",
        {
          pid: fakePid,
          branch: "main",
          startedAt: Date.now() - 5_000,
          lastUsedAt: Date.now() - 5_000,
        },
      );

      const killed = await manager.sweepNow();
      expect(killed).toEqual(["stale-repo"]);

      await waitFor(() => !isPidAlive(fakePid), 8_000);
      expect(isPidAlive(fakePid)).toBe(false);
    } finally {
      try {
        process.kill(fakePid, "SIGKILL");
      } catch {
        // already dead
      }
      manager.dispose();
    }
  }, 15_000);

  it("sweepNow() leaves fresh entries alone", async () => {
    const sleepProc = Bun.spawn(["sleep", "30"], { stdout: "pipe", stderr: "pipe" });
    const fakePid = sleepProc.pid;

    // 60-second TTL — anything just-set is well within the window.
    const manager = new DevServerManager([], new WorktreeManager([]), {
      idleTtlMs: 60_000,
      sweepIntervalMs: 60_000,
    });
    try {
      (manager as unknown as { state: Map<string, unknown> }).state.set(
        "fresh-repo",
        {
          pid: fakePid,
          branch: "main",
          startedAt: Date.now(),
          lastUsedAt: Date.now(),
        },
      );

      const killed = await manager.sweepNow();
      expect(killed).toEqual([]);
      expect(isPidAlive(fakePid)).toBe(true);
    } finally {
      try {
        process.kill(fakePid, "SIGKILL");
      } catch {
        // already dead
      }
      manager.dispose();
    }
  }, 10_000);
});
