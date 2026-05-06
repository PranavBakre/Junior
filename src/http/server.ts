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
import { handleHealth } from "./routes/health.ts";
import { handleSessions, handleSessionDetail } from "./routes/sessions.ts";
import { handleLogs } from "./routes/logs.ts";
import { handleMemoryList, handleMemoryRead } from "./routes/memory.ts";
import { handleDevServers } from "./routes/dev-server.ts";
import { log } from "../logger.ts";

const PUBLIC_DIR = path.resolve(import.meta.dir, "../../public");
const startedAt = new Date().toISOString();

function cors(res: Response): Response {
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return res;
}

export interface HttpServerDeps {
  store: SessionStore;
  config: Config;
  devServerManager: DevServerManager;
  devServerQueue: DevServerQueue;
  repos: RepoConfig[];
}

export function startHttpServer(deps: HttpServerDeps): void {
  const { store, config, devServerManager, devServerQueue, repos } = deps;

  const server = Bun.serve({
    port: config.http.port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "OPTIONS") {
        return cors(new Response(null, { status: 204 }));
      }

      try {
        let res: Response;

        if (url.pathname === "/" || url.pathname === "/index.html") {
          const file = Bun.file(path.join(PUBLIC_DIR, "index.html"));
          if (await file.exists()) {
            res = new Response(file, {
              headers: { "Content-Type": "text/html; charset=utf-8" },
            });
          } else {
            res = new Response("Dashboard not found. Create public/index.html", {
              status: 404,
            });
          }
          return cors(res);
        }

        if (url.pathname === "/api/health") {
          res = await handleHealth(store, config, startedAt);
        } else if (url.pathname === "/api/sessions") {
          res = await handleSessions(store);
        } else if (url.pathname.startsWith("/api/sessions/")) {
          const threadId = decodeURIComponent(
            url.pathname.slice("/api/sessions/".length),
          );
          res = await handleSessionDetail(store, threadId);
        } else if (url.pathname === "/api/dev-server") {
          res = await handleDevServers(devServerManager, devServerQueue, repos);
        } else if (url.pathname === "/api/logs") {
          res = await handleLogs(url.searchParams);
        } else if (url.pathname === "/api/memory") {
          res = await handleMemoryList();
        } else if (url.pathname.startsWith("/api/memory/")) {
          const filePath = decodeURIComponent(
            url.pathname.slice("/api/memory/".length),
          );
          res = await handleMemoryRead(filePath);
        } else {
          res = Response.json({ error: "not found" }, { status: 404 });
        }

        return cors(res);
      } catch (err) {
        log.error("http", `${req.method} ${url.pathname} — ${err}`);
        return cors(
          Response.json({ error: "internal server error" }, { status: 500 }),
        );
      }
    },
  });

  log.info(
    "boot",
    `HTTP dashboard listening on http://127.0.0.1:${server.port}`,
  );
}
