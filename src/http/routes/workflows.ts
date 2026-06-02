import type { WorkflowRegistry } from "../../workflows/registry.ts";
import type { WorkflowStore } from "../../workflows/store.ts";
import type { WorkflowDefinition, WorkflowRun } from "../../workflows/types.ts";

export async function handleWorkflows(
  registry: WorkflowRegistry,
  store: WorkflowStore,
): Promise<Response> {
  const definitions = registry.all();
  const states = await store.listStates();
  const stateByName = new Map(states.map((state) => [state.name, state]));
  const workflows = await Promise.all(
    definitions.map(async (definition) => ({
      ...projectDefinition(definition),
      state: stateByName.get(definition.name) ?? null,
      runs: (await store.listRuns(definition.name, 5)).map(projectRun),
    })),
  );

  return Response.json({
    workflows,
    errors: registry.getErrors(),
  });
}

function projectDefinition(definition: WorkflowDefinition) {
  return {
    name: definition.name,
    enabled: definition.enabled,
    description: definition.description ?? null,
    sourcePath: definition.sourcePath,
    sourceRoot: definition.sourceRoot,
    versionHash: definition.versionHash,
    triggers: definition.triggers,
    outputs: definition.outputs,
    runner: definition.runner ?? null,
    concurrency: definition.concurrency,
  };
}

function projectRun(run: WorkflowRun) {
  return {
    id: run.id,
    reason: run.reason,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    artifactPath: run.artifactPath,
    providerSessionId: run.providerSessionId,
    slackChannel: run.slackChannel,
    slackThreadTs: run.slackThreadTs,
    error: run.error,
  };
}
