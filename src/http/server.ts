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
import type { SlackPermalinkLookup } from "../slack/permalink-cache.ts";
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
import {
  handleWorkflowCreate,
  handleWorkflowDetail,
  handleWorkflowPut,
  handleWorkflowReload,
  handleWorkflowRun,
  handleWorkflowStart,
  handleWorkflowStop,
  handleWorkflows,
} from "./routes/workflows.ts";
import { handlePipelineArtifact, handlePipelines } from "./routes/pipelines.ts";
import { handleProfiles } from "./routes/profiles.ts";
import { handleSpend } from "./routes/spend.ts";
import { handleRunbookDetail, handleRunbooks } from "./routes/runbooks.ts";
import { handleAudit } from "./routes/audit.ts";
import { allowedMethods, matchApi } from "./match-api.ts";
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
  lookupSlackPermalink?: SlackPermalinkLookup;
  sessionManager: Pick<
    SessionManager,
    "injectDashboardContinue" | "interruptThread" | "isAdmin" | "isExplicitAdmin" | "getSession"
  >;
  slackPoster: SlackPoster;
  usageStore: UsageStore;
  auditStore: DashboardAuditStore;
  runbookCatalog?: CatalogStore;
  projectRoot?: string;
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
    lookupSlackPermalink,
    sessionManager,
    slackPoster,
    usageStore,
    auditStore,
    runbookCatalog,
    projectRoot,
  } = deps;

  const workflowDeps = {
    registry: workflowRegistry,
    store: workflowStore,
    scheduler: workflowScheduler,
    config,
    sessionManager,
    auditStore,
    slackPoster,
    projectRoot,
    repos,
  };

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

        if (url.pathname.startsWith("/js/") || url.pathname.startsWith("/assets/")) {
          const resolved = resolvePublicStaticPath(url.pathname);
          if (!resolved) {
            return new Response("not found", { status: 404 });
          }
          const file = Bun.file(resolved);
          if (await file.exists()) {
            return new Response(file, {
              headers: {
                "Content-Type": url.pathname.endsWith(".css")
                  ? "text/css; charset=utf-8"
                  : "text/javascript; charset=utf-8",
                "Cache-Control": "no-cache",
              },
            });
          }
          return new Response("not found", { status: 404 });
        }

        if (url.pathname.startsWith("/api/")) {
          const route = matchApi(url.pathname);
          if (route.kind === "not-found") {
            return Response.json({ error: "not found" }, { status: 404 });
          }
          const allowed = allowedMethods(route.kind);
          if (!allowed.includes(req.method)) {
            return Response.json({ error: "method not allowed" }, { status: 405 });
          }
          switch (route.kind) {
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
                route.threadId,
                resolveSlackPermalink,
                usageStore,
              );
            case "session-continue":
              return await handleSessionContinue(req, route.threadId, {
                sessionManager,
                slackPoster,
                auditStore,
                config,
              });
            case "session-stop":
              return await handleSessionStop(route.threadId, {
                sessionManager,
                slackPoster,
                auditStore,
                config,
              });
            case "dev-server":
              return await handleDevServers(devServerManager, devServerQueue, repos);
            case "workflows":
              if (req.method === "POST") {
                return await handleWorkflowCreate(req, workflowDeps);
              }
              return await handleWorkflows(
                workflowRegistry,
                workflowStore,
                workflowScheduler,
                projectRoot,
              );
            case "workflow":
              if (req.method === "PUT") {
                return await handleWorkflowPut(route.name, req, workflowDeps);
              }
              return await handleWorkflowDetail(route.name, workflowDeps);
            case "workflow-run":
              return await handleWorkflowRun(route.name, req, workflowDeps);
            case "workflow-start":
              return await handleWorkflowStart(route.name, workflowDeps);
            case "workflow-stop":
              return await handleWorkflowStop(route.name, workflowDeps);
            case "workflow-reload":
              return await handleWorkflowReload(workflowDeps);
            case "pipelines":
              return await handlePipelines(pipelineStore, url.searchParams, undefined, {
                runtimeMode: config.pipeline?.runtimeMode ?? "off",
                lookupSlackPermalink,
              });
            case "pipeline":
              return await handlePipelines(pipelineStore, url.searchParams, route.id, {
                runtimeMode: config.pipeline?.runtimeMode ?? "off",
                resolveSlackPermalink,
              });
            case "pipeline-artifacts":
              return await handlePipelineArtifact(
                pipelineStore,
                route.id,
                url.searchParams,
              );
            case "spend":
              return await handleSpend(usageStore, url.searchParams);
            case "runbooks":
              return await handleRunbooks(url.searchParams, runbookCatalog);
            case "runbook":
              return await handleRunbookDetail(route.name, runbookCatalog);
            case "audit":
              return await handleAudit(auditStore, url.searchParams);
            case "logs":
              return await handleLogs(url.searchParams);
            case "profiles":
              if (!profileStore) {
                return Response.json({ error: "profile store not available" }, { status: 503 });
              }
              return await handleProfiles(profileStore, url.searchParams);
            case "memory":
              return await handleMemoryList();
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
            case "memory-read":
              return await handleMemoryRead(route.filePath);
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
