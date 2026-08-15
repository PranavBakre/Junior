import { WORKFLOW_NAME_RE } from "../workflows/definition.ts";

export type MatchedApi =
  | { kind: "health" }
  | { kind: "sessions" }
  | { kind: "session"; threadId: string }
  | { kind: "session-continue"; threadId: string }
  | { kind: "session-stop"; threadId: string }
  | { kind: "dev-server" }
  | { kind: "workflows" }
  | { kind: "workflow-reload" }
  | { kind: "workflow"; name: string }
  | { kind: "workflow-run"; name: string }
  | { kind: "workflow-start"; name: string }
  | { kind: "workflow-stop"; name: string }
  | { kind: "pipelines" }
  | { kind: "pipeline"; id: string }
  | { kind: "pipeline-artifacts"; id: string }
  | { kind: "spend" }
  | { kind: "runbooks" }
  | { kind: "runbook"; name: string }
  | { kind: "audit" }
  | { kind: "logs" }
  | { kind: "profiles" }
  | { kind: "memory" }
  | { kind: "memory-recall" }
  | { kind: "memory-projection" }
  | { kind: "memory-read"; filePath: string }
  | { kind: "not-found" };

const GET = ["GET"] as const;
const POST = ["POST"] as const;

export function allowedMethods(kind: MatchedApi["kind"]): readonly string[] {
  switch (kind) {
    case "session-continue":
    case "session-stop":
    case "workflow-reload":
    case "workflow-run":
    case "workflow-start":
    case "workflow-stop":
      return POST;
    case "not-found":
      return [];
    default:
      return GET;
  }
}

export function matchApi(pathname: string): MatchedApi {
  if (pathname === "/api/health") return { kind: "health" };
  if (pathname === "/api/sessions") return { kind: "sessions" };
  if (pathname.startsWith("/api/sessions/")) {
    const rest = decodeURIComponent(pathname.slice("/api/sessions/".length));
    const parts = rest.split("/").filter(Boolean);
    if (parts.length === 1) return { kind: "session", threadId: parts[0]! };
    if (parts.length === 2 && parts[1] === "continue") {
      return { kind: "session-continue", threadId: parts[0]! };
    }
    if (parts.length === 2 && parts[1] === "stop") {
      return { kind: "session-stop", threadId: parts[0]! };
    }
    return { kind: "not-found" };
  }
  if (pathname === "/api/dev-server") return { kind: "dev-server" };
  if (pathname === "/api/workflows") return { kind: "workflows" };
  if (pathname === "/api/workflows/reload") return { kind: "workflow-reload" };
  if (pathname.startsWith("/api/workflows/")) {
    const rest = decodeURIComponent(pathname.slice("/api/workflows/".length));
    const parts = rest.split("/").filter(Boolean);
    if (parts.length === 1 && WORKFLOW_NAME_RE.test(parts[0]!)) {
      return { kind: "workflow", name: parts[0]! };
    }
    if (parts.length === 2 && WORKFLOW_NAME_RE.test(parts[0]!)) {
      if (parts[1] === "run") return { kind: "workflow-run", name: parts[0]! };
      if (parts[1] === "start") return { kind: "workflow-start", name: parts[0]! };
      if (parts[1] === "stop") return { kind: "workflow-stop", name: parts[0]! };
    }
    return { kind: "not-found" };
  }
  if (pathname === "/api/pipelines") return { kind: "pipelines" };
  if (pathname.startsWith("/api/pipelines/")) {
    const rest = decodeURIComponent(pathname.slice("/api/pipelines/".length));
    const artifactsMatch = rest.match(/^([^/]+)\/artifacts$/);
    if (artifactsMatch?.[1]) {
      return { kind: "pipeline-artifacts", id: artifactsMatch[1] };
    }
    if (!rest || rest.includes("/")) return { kind: "not-found" };
    return { kind: "pipeline", id: rest };
  }
  if (pathname === "/api/spend") return { kind: "spend" };
  if (pathname === "/api/runbooks") return { kind: "runbooks" };
  if (pathname.startsWith("/api/runbooks/")) {
    const name = decodeURIComponent(pathname.slice("/api/runbooks/".length));
    if (!name || name.includes("/")) return { kind: "not-found" };
    return { kind: "runbook", name };
  }
  if (pathname === "/api/audit") return { kind: "audit" };
  if (pathname === "/api/logs") return { kind: "logs" };
  if (pathname === "/api/profiles") return { kind: "profiles" };
  if (pathname === "/api/memory") return { kind: "memory" };
  if (pathname === "/api/memory/recall") return { kind: "memory-recall" };
  if (pathname === "/api/memory/projection") return { kind: "memory-projection" };
  if (pathname.startsWith("/api/memory/")) {
    const filePath = decodeURIComponent(pathname.slice("/api/memory/".length));
    if (!filePath) return { kind: "not-found" };
    return { kind: "memory-read", filePath };
  }
  return { kind: "not-found" };
}
