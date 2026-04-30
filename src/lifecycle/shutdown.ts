import type { SessionManager } from "../session/manager.ts";
import type { SessionStore } from "../session/store/interface.ts";
import type { DevServerManager } from "./dev-server.ts";

export function setupGracefulShutdown(
  manager: SessionManager,
  store: SessionStore,
  devServerManager?: DevServerManager,
): void {
  const shutdown = async () => {
    console.log("Shutting down...");

    const hardExitTimer = setTimeout(() => {
      console.error("Shutdown timed out, forcing exit");
      process.exit(1);
    }, 30_000);

    try {
      const sessions = await store.getAll();
      const kills: Promise<void>[] = [];

      for (const [threadId, session] of sessions) {
        if (session.status === "busy") {
          kills.push(manager.resetSession(threadId));
        }
      }

      // Kill all managed dev servers in parallel with session teardown.
      if (devServerManager) {
        kills.push(devServerManager.killAll());
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
