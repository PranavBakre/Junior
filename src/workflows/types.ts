export const PUBLIC_WORKFLOW_ROOT = "workflows";
export const OVERLAY_WORKFLOW_ROOT = "agents-org/workflows";
export const WORKFLOW_ARTIFACT_ROOT = "data/workflow-runs";

export type WorkflowSourceRoot = "public" | "overlay";
export type WorkflowRuntimeStatus = "active" | "stopped" | "invalid";
export type WorkflowRunReason = "schedule" | "command" | "event" | "manual";
export type WorkflowRunStatus = "running" | "success" | "failed" | "skipped";
export type WorkflowLastRunStatus = Exclude<WorkflowRunStatus, "running">;
export type WorkflowConcurrency = "skip" | "parallel";
export type WorkflowRunnerProvider = "default" | "opencode" | "claude";
export type WorkflowTool =
  | "git"
  | "gh"
  | "slack.post"
  | "docs.write";

export interface WorkflowScheduleTrigger {
  type: "schedule";
  cron: string;
  timezone: string;
}

export interface WorkflowCommandTrigger {
  type: "command";
  command: string;
}

export interface WorkflowSlackEventTrigger {
  type: "slack-event";
  channel: string;
  pattern?: string;
}

export type WorkflowTrigger =
  | WorkflowScheduleTrigger
  | WorkflowCommandTrigger
  | WorkflowSlackEventTrigger;

export interface WorkflowDocsOutput {
  type: "docs";
  path: string;
}

export interface WorkflowSlackOutput {
  type: "slack";
  channel: string;
  threadTs?: string | null;
}

export interface WorkflowSlackThreadOutput {
  type: "slack-thread";
  channel: string;
}

export type WorkflowOutput =
  | WorkflowDocsOutput
  | WorkflowSlackOutput
  | WorkflowSlackThreadOutput;

export interface WorkflowRunnerConfig {
  provider: WorkflowRunnerProvider;
  agentName: string;
  timeoutMs?: number;
  model?: string | null;
}

export interface WorkflowPermissions {
  repos?: string[];
  tools: WorkflowTool[];
}

export interface WorkflowFallback {
  mode: "deterministic-summary";
}

export interface WorkflowDefinition {
  name: string;
  enabled: boolean;
  description?: string;
  ownerSlackUserIds: string[];
  triggers: WorkflowTrigger[];
  outputs: WorkflowOutput[];
  runner?: WorkflowRunnerConfig;
  permissions: WorkflowPermissions;
  fallback?: WorkflowFallback;
  concurrency: WorkflowConcurrency;
  prompt: string;
  versionHash: string;
  sourcePath: string;
  sourceRoot: WorkflowSourceRoot;
}

export interface WorkflowState {
  name: string;
  status: WorkflowRuntimeStatus;
  activeVersionHash: string;
  sourcePath: string;
  lastLoadedAt: number;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastRunStatus: WorkflowLastRunStatus | null;
  lastError: string | null;
}

export interface WorkflowRun {
  id: string;
  workflowName: string;
  workflowVersionHash: string;
  sourcePath: string;
  reason: WorkflowRunReason;
  actorSlackUserId: string | null;
  status: WorkflowRunStatus;
  startedAt: number;
  finishedAt: number | null;
  artifactPath: string;
  providerSessionId: string | null;
  slackChannel: string | null;
  slackThreadTs: string | null;
  error: string | null;
}

export interface WorkflowValidationError {
  path: string;
  message: string;
}

export function isHumanTriggerReason(reason: WorkflowRunReason): boolean {
  return reason === "command" || reason === "event" || reason === "manual";
}
