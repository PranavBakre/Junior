import type { Config } from "../../config.ts";
import type { SessionStore } from "../../session/store/interface.ts";

export async function handleHealth(
  store: SessionStore,
  config: Config,
  startedAt: string,
): Promise<Response> {
  const allSessions = await store.getAll();
  let busy = 0, idle = 0, draining = 0, errors = 0;
  let totalAgents = 0, busyAgents = 0;
  let activePipelineRuns = 0;

  for (const s of allSessions.values()) {
    if (s.status === "busy") busy++;
    else if (s.status === "draining") draining++;
    else idle++;
    if (s.lastError) errors++;
    if (s.activePipelineRunId) activePipelineRuns++;

    for (const agent of Object.values(s.agentSessions ?? {})) {
      totalAgents++;
      if (agent.status === "busy") busyAgents++;
    }
  }

  return Response.json({
    status: "ok",
    uptime: Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000),
    startedAt,
    version: "0.1.0",
    sessions: { total: allSessions.size, busy, idle, draining, errors },
    agents: { total: totalAgents, busy: busyAgents },
    repos: config.repos.map((r) => r.name),
    // One-line pipeline observability for the local dashboard.
    pipeline: {
      runtimeMode: config.pipeline?.runtimeMode ?? "off",
      bugPipelineEnabled: config.pipeline?.bugPipelineEnabled ?? false,
      productPipelineEnabled: config.pipeline?.productPipelineEnabled ?? false,
      githubReconcileEnabled: config.github?.reconcileEnabled ?? false,
      githubEventWakeEnabled: config.github?.eventWakeEnabled ?? false,
      sessionsWithActiveRun: activePipelineRuns,
    },
  });
}
