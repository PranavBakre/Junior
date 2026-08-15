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
import type { WorkflowScheduler } from "../workflows/scheduler.ts";
import type { WorkflowStore } from "../workflows/store.ts";
import type { MemoryStore } from "../memory/store.ts";
import type { PipelineStore } from "../pipelines/store/interface.ts";
import type { ProfileStore } from "../memory/profiles/store.ts";
import type { CatalogStore } from "../runbooks/catalog-store.ts";
import type { UsageStore } from "../usage/store/interface.ts";
import type { DashboardAuditStore } from "./audit/interface.ts";
import { handleHealth } from "./routes/health.ts";
import type { SessionManager } from "../session/manager.ts";
import {
  handleSessions,
  handleSessionDetail,
  handleSessionContinue,
  handleSessionStop,
  type SlackPermalinkResolver,
  type SlackPoster,
} from "./routes/sessions.ts";
import { handleLogs } from "./routes/logs.ts";
import { handleMemoryList, handleMemoryProjection, handleMemoryRead, handleMemoryRecall } from "./routes/memory.ts";
import { handleDevServers } from "./routes/dev-server.ts";
import { handleWorkflows } from "./routes/workflows.ts";
import { handlePipelineArtifact, handlePipelines } from "./routes/pipelines.ts";
import { handleProfiles } from "./routes/profiles.ts";
import { handleSpend } from "./routes/spend.ts";
import { handleRunbookDetail, handleRunbooks } from "./routes/runbooks.ts";
import { handleAudit } from "./routes/audit.ts";
import { log } from "../logger.ts";

const PUBLIC_DIR = path.resolve(import.meta.dir, "../../public");
const startedAt = new Date().toISOString();

/** Resolve `/js/*` and leftover `/assets/*` under `public/`, or null if unsafe. */
export function resolvePublicStaticPath(pathname: string): string | null {
  if (!pathname.startsWith("/js/") && !pathname.startsWith("/assets/")) return null;
  const relative = decodeURIComponent(pathname.slice(1));
  if (
    !relative ||
    relative.includes("\0") ||
    relative.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    return null;
  }
  const resolved = path.resolve(PUBLIC_DIR, relative);
  if (!resolved.startsWith(PUBLIC_DIR + path.sep)) return null;
  return resolved;
}

export interface HttpServerDeps {
  store: SessionStore;
  config: Config;
  devServerManager: DevServerManager;
  devServerQueue: DevServerQueue;
  repos: RepoConfig[];
  workflowRegistry: WorkflowRegistry;
  workflowScheduler: WorkflowScheduler;
  workflowStore: WorkflowStore;
  memoryStore?: MemoryStore;
  profileStore?: ProfileStore;
  pipelineStore: PipelineStore;
  resolveSlackPermalink?: SlackPermalinkResolver;
  sessionManager: Pick<
    SessionManager,
    "injectDashboardContinue" | "interruptThread" | "isAdmin" | "isExplicitAdmin" | "getSession"
  >;
  slackPoster: SlackPoster;
  usageStore: UsageStore;
  auditStore: DashboardAuditStore;
  runbookCatalog?: CatalogStore;
}

export type MatchedApi =
  | { route: "health" }
  | { route: "sessions" }
  | { route: "session"; threadId: string }
  | { route: "session-continue"; threadId: string }
  | { route: "session-stop"; threadId: string }
  | { route: "dev-server" }
  | { route: "workflows" }
  | { route: "pipelines" }
  | { route: "pipeline"; runId: string }
  | { route: "pipeline-artifacts"; runId: string }
  | { route: "spend" }
  | { route: "runbooks" }
  | { route: "runbook"; name: string }
  | { route: "audit" }
  | { route: "logs" }
  | { route: "profiles" }
  | { route: "memory" }
  | { route: "memory-recall" }
  | { route: "memory-projection" }
  | { route: "memory-read"; filePath: string }
  | { route: "not-found" };

const API_METHODS: Record<Exclude<MatchedApi["route"], "not-found">, readonly string[]> = {
  health: ["GET"],
  sessions: ["GET"],
  session: ["GET"],
  "session-continue": ["POST"],
  "session-stop": ["POST"],
  "dev-server": ["GET"],
  workflows: ["GET"],
  pipelines: ["GET"],
  pipeline: ["GET"],
  "pipeline-artifacts": ["GET"],
  spend: ["GET"],
  runbooks: ["GET"],
  runbook: ["GET"],
  audit: ["GET"],
  logs: ["GET"],
  profiles: ["GET"],
  memory: ["GET"],
  "memory-recall": ["GET"],
  "memory-projection": ["GET"],
  "memory-read": ["GET"],
};

export function matchApi(pathname: string): MatchedApi {
  if (!pathname.startsWith("/api/")) return { route: "not-found" };
  const raw = pathname.slice("/api/".length);
  if (!raw) return { route: "not-found" };
  const parts = raw.split("/").filter((part) => part !== "").map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
  const [head, ...rest] = parts;
  if (head === "health" && rest.length === 0) return { route: "health" };
  if (head === "sessions" && rest.length === 0) return { route: "sessions" };
  if (head === "sessions" && rest.length === 1) {
    return { route: "session", threadId: rest[0]! };
  }
  if (head === "sessions" && rest.length === 2 && rest[1] === "continue") {
    return { route: "session-continue", threadId: rest[0]! };
  }
  if (head === "sessions" && rest.length === 2 && rest[1] === "stop") {
    return { route: "session-stop", threadId: rest[0]! };
  }
  if (head === "dev-server" && rest.length === 0) return { route: "dev-server" };
  if (head === "workflows" && rest.length === 0) return { route: "workflows" };
  if (head === "pipelines" && rest.length === 0) return { route: "pipelines" };
  if (head === "pipelines" && rest.length === 1) {
    return { route: "pipeline", runId: rest[0]! };
  }
  if (head === "pipelines" && rest.length === 2 && rest[1] === "artifacts") {
    return { route: "pipeline-artifacts", runId: rest[0]! };
  }
  if (head === "spend" && rest.length === 0) return { route: "spend" };
  if (head === "runbooks" && rest.length === 0) return { route: "runbooks" };
  if (head === "runbooks" && rest.length === 1) {
    return { route: "runbook", name: rest[0]! };
  }
  if (head === "audit" && rest.length === 0) return { route: "audit" };
  if (head === "logs" && rest.length === 0) return { route: "logs" };
  if (head === "profiles" && rest.length === 0) return { route: "profiles" };
  if (head === "memory" && rest.length === 0) return { route: "memory" };
  if (head === "memory" && rest.length === 1 && rest[0] === "recall") {
    return { route: "memory-recall" };
  }
  if (head === "memory" && rest.length === 1 && rest[0] === "projection") {
    return { route: "memory-projection" };
  }
  if (head === "memory") {
    return { route: "memory-read", filePath: rest.join("/") };
  }
  return { route: "not-found" };
}

function methodNotAllowed(): Response {
  return Response.json({ error: "method not allowed" }, { status: 405 });
}

export function startHttpServer(deps: HttpServerDeps): ReturnType<typeof Bun.serve> {
  const {
    store,
    config,
    devServerManager,
    devServerQueue,
    repos,
    workflowRegistry,
    workflowScheduler,
    workflowStore,
    memoryStore,
    profileStore,
    pipelineStore,
    resolveSlackPermalink,
    sessionManager,
    slackPoster,
    usageStore,
    auditStore,
    runbookCatalog,
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

        const threeAsset = {
          "/assets/three.module.js": "three.module.min.js",
          "/assets/three.core.min.js": "three.core.min.js",
        }[url.pathname];
        if (threeAsset) {
          const file = Bun.file(
            path.resolve(import.meta.dir, "../../node_modules/three/build", threeAsset),
          );
          if (await file.exists()) {
            return new Response(file, {
              headers: {
                "Content-Type": "text/javascript; charset=utf-8",
                "Cache-Control": "public, max-age=86400",
              },
            });
          }
          return new Response("Three.js runtime not found", { status: 404 });
        }

        if (url.pathname === "/assets/pipeline-worker.js") {
          const file = Bun.file(path.join(PUBLIC_DIR, "pipeline-worker.js"));
          if (await file.exists()) {
            return new Response(file, {
              headers: {
                "Content-Type": "text/javascript; charset=utf-8",
                "Cache-Control": "no-cache",
              },
            });
          }
          return new Response("Pipeline worker not found", { status: 404 });
        }

        if (url.pathname.startsWith("/js/") || url.pathname.startsWith("/assets/")) {
          const resolved = resolvePublicStaticPath(url.pathname);
          if (!resolved) {
            return new Response("not found", { status: 404 });
          }
          const file = Bun.file(resolved);
          if (await file.exists()) {
            return new Response(file, {
              headers: {
                "Content-Type": "text/javascript; charset=utf-8",
                "Cache-Control": "no-cache",
              },
            });
          }
          return new Response("not found", { status: 404 });
        }

        if (url.pathname.startsWith("/api/")) {
          const matched = matchApi(url.pathname);
          if (matched.route === "not-found") {
            return Response.json({ error: "not found" }, { status: 404 });
          }
          if (!API_METHODS[matched.route].includes(req.method)) {
            return methodNotAllowed();
          }
          switch (matched.route) {
            case "health":
              return await handleHealth(store, config, startedAt, {
                usageStore,
                auditStore,
              });
            case "sessions":
              return await handleSessions(store, usageStore);
            case "session":
              return await handleSessionDetail(
                store,
                matched.threadId,
                resolveSlackPermalink,
                usageStore,
              );
            case "session-continue":
              return await handleSessionContinue(req, matched.threadId, {
                sessionManager,
                slackPoster,
                auditStore,
                config,
              });
            case "session-stop":
              return await handleSessionStop(matched.threadId, {
                sessionManager,
                slackPoster,
                auditStore,
                config,
              });
            case "dev-server":
              return await handleDevServers(devServerManager, devServerQueue, repos);
            case "workflows":
              return await handleWorkflows(
                workflowRegistry,
                workflowStore,
                workflowScheduler,
              );
            case "pipelines":
              return await handlePipelines(pipelineStore, url.searchParams, undefined, {
                runtimeMode: config.pipeline?.runtimeMode ?? "off",
                resolveSlackPermalink,
              });
            case "pipeline":
              return await handlePipelines(
                pipelineStore,
                url.searchParams,
                matched.runId,
                {
                  runtimeMode: config.pipeline?.runtimeMode ?? "off",
                  resolveSlackPermalink,
                },
              );
            case "pipeline-artifacts":
              return await handlePipelineArtifact(
                pipelineStore,
                matched.runId,
                url.searchParams,
              );
            case "spend":
              return await handleSpend(usageStore, url.searchParams);
            case "runbooks":
              return await handleRunbooks(url.searchParams, runbookCatalog);
            case "runbook":
              return await handleRunbookDetail(matched.name, runbookCatalog);
            case "audit":
              return await handleAudit(auditStore, url.searchParams);
            case "logs":
              return await handleLogs(url.searchParams);
            case "profiles":
              if (!profileStore) {
                return Response.json({ error: "profile store not available" }, { status: 503 });
              }
              return await handleProfiles(profileStore, url.searchParams);
            case "memory-recall":
              if (!memoryStore) {
                return Response.json({ error: "memory store not available" }, { status: 503 });
              }
              return await handleMemoryRecall(memoryStore, url.searchParams);
            case "memory-projection":
              if (!memoryStore) {
                return Response.json({ error: "memory store not available" }, { status: 503 });
              }
              return await handleMemoryProjection(memoryStore, url.searchParams);
            case "memory":
              return await handleMemoryList();
            case "memory-read":
              return await handleMemoryRead(matched.filePath);
          }
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
  return server;
}
