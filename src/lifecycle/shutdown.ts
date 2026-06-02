import type { SessionManager } from "../session/manager.ts";
import type { DevServerManager } from "./dev-server.ts";

export function setupGracefulShutdown(
  manager: SessionManager,
  devServerManager?: DevServerManager,
  extraShutdown?: () => void | Promise<void>,
): void {
  const shutdown = async () => {
    console.log("Shutting down...");

    const hardExitTimer = setTimeout(() => {
      console.error("Shutdown timed out, forcing exit");
      process.exit(1);
    }, 30_000);

    try {
      const kills: Promise<void>[] = [];
      kills.push(manager.terminateActiveRuns("shutdown"));

      // Kill all managed dev servers in parallel with session teardown.
      if (devServerManager) {
        kills.push(devServerManager.killAll());
      }
      if (extraShutdown) {
        kills.push((async () => {
          await extraShutdown();
        })());
      }

      await Promise.all(kills);
    } catch (err) {
      console.error("Error during shutdown:", err);
    }

    clearTimeout(hardExitTimer);
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
