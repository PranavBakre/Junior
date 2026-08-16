import type { ThreadSession } from "./types.ts";

export type ContinueRoute =
  | { kind: "top-level"; handle: "default" }
  | { kind: "worker"; agentName: string };

export function resolveContinueRoute(
  requested: string | undefined,
  session: ThreadSession,
): ContinueRoute | { error: "unknown-agent" } {
  const raw = requested ?? session.defaultAgent ?? session.activeAgentName ?? "default";
  if (raw === "default" || raw === "junior") return { kind: "top-level", handle: "default" };
  if (session.agentSessions?.[raw]) return { kind: "worker", agentName: raw };
  return { error: "unknown-agent" };
}
