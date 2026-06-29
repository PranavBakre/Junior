/**
 * HTTP dashboard for Junior — ported from Friday's `src/http/` with
 * Junior-specific extensions: the `/api/dev-server` endpoint surfaces
 * DevServerManager + DevServerQueue state, and `/api/sessions` joins the
 * `agent_sessions` table so the UI can render multi-agent threads.
 *
 * Localhost-only by design (binds 127.0.0.1, no auth). Gated on the
 * `HTTP_DASHBOARD_PORT` env var; off by default.
 */
import path from "node:path";
import type { Config, RepoConfig } from "../config.ts";
import type { SessionStore } from "../session/store/interface.ts";
import type { DevServerManager } from "../lifecycle/dev-server.ts";
import type { DevServerQueue } from "../lifecycle/dev-server-queue.ts";
import type { WorkflowRegistry } from "../workflows/registry.ts";
import type { WorkflowStore } from "../workflows/store.ts";
import type { MemoryStore } from "../memory/store.ts";
import { handleHealth } from "./routes/health.ts";
import { handleSessions, handleSessionDetail } from "./routes/sessions.ts";
import { handleLogs } from "./routes/logs.ts";
import { handleMemoryList, handleMemoryProjection, handleMemoryRead, handleMemoryRecall } from "./routes/memory.ts";
import { handleDevServers } from "./routes/dev-server.ts";
import { handleWorkflows } from "./routes/workflows.ts";
import { log } from "../logger.ts";

const PUBLIC_DIR = path.resolve(import.meta.dir, "../../public");
const startedAt = new Date().toISOString();

export interface HttpServerDeps {
  store: SessionStore;
  config: Config;
  devServerManager: DevServerManager;
  devServerQueue: DevServerQueue;
  repos: RepoConfig[];
  workflowRegistry: WorkflowRegistry;
  workflowStore: WorkflowStore;
  memoryStore?: MemoryStore;
}

export function startHttpServer(deps: HttpServerDeps): void {
  const {
    store,
    config,
    devServerManager,
    devServerQueue,
    repos,
    workflowRegistry,
    workflowStore,
    memoryStore,
  } = deps;

  const server = Bun.serve({
    port: config.http.port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);

      // No CORS headers — the dashboard at public/index.html is served from
      // the same origin (127.0.0.1:<port>) as the API, so cross-origin support
      // would only let arbitrary websites read this server's data when the
      // operator visits them. Loopback-only binding is the threat model.
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204 });
      }

      try {
        if (url.pathname === "/" || url.pathname === "/index.html") {
          const file = Bun.file(path.join(PUBLIC_DIR, "index.html"));
          if (await file.exists()) {
            return new Response(file, {
              headers: { "Content-Type": "text/html; charset=utf-8" },
            });
          }
          return new Response("Dashboard not found. Create public/index.html", {
            status: 404,
          });
        }

        if (url.pathname === "/api/health") {
          return await handleHealth(store, config, startedAt);
        } else if (url.pathname === "/api/sessions") {
          return await handleSessions(store);
        } else if (url.pathname.startsWith("/api/sessions/")) {
          const threadId = decodeURIComponent(
            url.pathname.slice("/api/sessions/".length),
          );
          return await handleSessionDetail(store, threadId);
        } else if (url.pathname === "/api/dev-server") {
          return await handleDevServers(devServerManager, devServerQueue, repos);
        } else if (url.pathname === "/api/workflows") {
          return await handleWorkflows(workflowRegistry, workflowStore);
        } else if (url.pathname === "/api/logs") {
          return await handleLogs(url.searchParams);
        } else if (url.pathname === "/api/memory/recall") {
          if (!memoryStore) return Response.json({ error: "memory store not available" }, { status: 503 });
          return await handleMemoryRecall(memoryStore, url.searchParams);
        } else if (url.pathname === "/api/memory/projection") {
          if (!memoryStore) return Response.json({ error: "memory store not available" }, { status: 503 });
          return await handleMemoryProjection(memoryStore);
        } else if (url.pathname === "/api/memory") {
          return await handleMemoryList();
        } else if (url.pathname.startsWith("/api/memory/")) {
          const filePath = decodeURIComponent(
            url.pathname.slice("/api/memory/".length),
          );
          return await handleMemoryRead(filePath);
        }
        return Response.json({ error: "not found" }, { status: 404 });
      } catch (err) {
        log.error("http", `${req.method} ${url.pathname} — ${err}`);
        return Response.json(
          { error: "internal server error" },
          { status: 500 },
        );
      }
    },
  });

  log.info(
    "boot",
    `HTTP dashboard listening on http://127.0.0.1:${server.port}`,
  );
}
