/**
 * Small process / port helpers shared by `dev-server.ts` and
 * `dev-server-queue.ts`. Both modules need to ask the same two questions
 * ("is this PID alive?", "is something listening on this port?") and were
 * carrying identical copies before this extraction.
 */

/** Send signal 0 to check if a PID is alive. Returns false if ESRCH. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a TCP port is already bound by attempting a non-blocking connect
 * via Node's `net` module.
 *
 * Works on both macOS and Linux without depending on external tools (lsof,
 * fuser, ss). 3-second timeout — anything longer than that and the port is
 * either firewalled (treated as not-held) or held by something pathological.
 */
export async function isPortHeld(port: number): Promise<boolean> {
  const net = await import("node:net");
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const done = (held: boolean) => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(held);
      }
    };

    socket.setTimeout(3_000);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
    socket.connect(port, "127.0.0.1");
  });
}
