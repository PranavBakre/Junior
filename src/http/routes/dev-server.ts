import type { RepoConfig } from "../../config.ts";
import type { DevServerManager, DevServerState } from "../../lifecycle/dev-server.ts";
import type { DevServerQueue } from "../../lifecycle/dev-server-queue.ts";

const IDLE_TTL_MS = 20 * 60 * 1_000;

export async function handleDevServers(
  manager: DevServerManager,
  queue: DevServerQueue,
  repos: RepoConfig[],
): Promise<Response> {
  const statusMap = manager.status() as Map<string, DevServerState>;
  const now = Date.now();

  const items = await Promise.all(
    repos
      .filter((r) => r.devCommand)
      .map(async (repo) => {
        const state = statusMap.get(repo.name);
        const queueDepth = await queue.readQueueDepth(repo.name);

        const idleMsRemaining =
          state?.lastUsedAt != null
            ? Math.max(0, IDLE_TTL_MS - (now - state.lastUsedAt))
            : null;

        return {
          repo: repo.name,
          devCommand: repo.devCommand ?? null,
          devPort: repo.devPort ?? null,
          readyUrl: repo.readyUrl ?? (repo.devPort ? `http://localhost:${repo.devPort}` : null),
          running: state?.pid != null,
          pid: state?.pid ?? null,
          branch: state?.branch ?? queueDepth.holder?.branch ?? null,
          startedAt: state?.startedAt ?? null,
          lastUsedAt: state?.lastUsedAt ?? null,
          idleMsRemaining,
          holder: queueDepth.holder,
          waiters: queueDepth.waiters,
        };
      }),
  );

  return Response.json({ devServers: items, idleTtlMs: IDLE_TTL_MS });
}
