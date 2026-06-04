#!/usr/bin/env node

const separator = process.argv.indexOf("--");
const command = separator === -1 ? [] : process.argv.slice(separator + 1);

if (command.length === 0) {
  console.error("Usage: junior-mcp-stdio-wrapper.js -- <command> [args...]");
  process.exit(64);
}

const { spawn } = await import("node:child_process");

let exiting = false;
const child = spawn(command[0], command.slice(1), {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    JUNIOR_MCP_WRAPPED: "1",
  },
  detached: true,
});

process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);

function signalChild(signal = "SIGTERM") {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  }
}

function shutdown(signal = "SIGTERM") {
  if (exiting) return;
  exiting = true;
  signalChild(signal);
  setTimeout(() => signalChild("SIGKILL"), 2_000).unref();
}

process.stdin.on("end", () => {
  child.stdin.end();
  shutdown("SIGTERM");
});
process.stdin.on("close", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGHUP", () => shutdown("SIGTERM"));

child.on("exit", (code, signal) => {
  exiting = true;
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on("error", (err) => {
  console.error(`[junior-mcp-wrapper] ${err.message}`);
  process.exit(127);
});
