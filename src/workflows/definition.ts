import { createHash } from "node:crypto";
import { basename, isAbsolute, normalize } from "node:path";
import { CronExpressionParser } from "cron-parser";
import { parse as parseYaml } from "yaml";
import type { RepoConfig } from "../config.ts";
import type {
  WorkflowConcurrency,
  WorkflowDefinition,
  WorkflowOutput,
  WorkflowPermissions,
  WorkflowRunnerConfig,
  WorkflowSourceRoot,
  WorkflowTool,
  WorkflowTrigger,
} from "./types.ts";
import { WORKFLOW_ARTIFACT_ROOT } from "./types.ts";

export interface LoadWorkflowDefinitionOptions {
  path: string;
  sourceRoot: WorkflowSourceRoot;
  repos: RepoConfig[];
  builtInCommands?: Set<string>;
}

const WORKFLOW_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const COMMAND_RE = /^[a-z0-9][a-z0-9-]*$/;
const SLACK_CHANNEL_RE = /^[CDG][A-Z0-9]+$/;
const SLACK_USER_RE = /^U[A-Z0-9]+$/;
const SUPPORTED_TOOLS = new Set<WorkflowTool>([
  "git",
  "gh",
  "slack.post",
  "docs.write",
]);

export async function loadWorkflowDefinition(
  options: LoadWorkflowDefinitionOptions,
): Promise<WorkflowDefinition | null> {
  const file = Bun.file(options.path);
  if (!(await file.exists())) return null;
  const content = await file.text();
  const { frontmatter, body } = parseFrontmatter(content, options.path);
  return validateWorkflowDefinition({
    frontmatter,
    body,
    content,
    path: options.path,
    sourceRoot: options.sourceRoot,
    repos: options.repos,
    builtInCommands: options.builtInCommands ?? new Set(),
  });
}

export function validateWorkflowDefinition(options: {
  frontmatter: unknown;
  body: string;
  content: string;
  path: string;
  sourceRoot: WorkflowSourceRoot;
  repos: RepoConfig[];
  builtInCommands?: Set<string>;
}): WorkflowDefinition {
  const fm = objectRecord(options.frontmatter, "frontmatter");
  const filename = basename(options.path);
  if (!filename.endsWith(".workflow.md")) {
    throw new Error(`Workflow file must end with .workflow.md: ${filename}`);
  }
  const stem = filename.slice(0, -".workflow.md".length);

  const name = stringField(fm, "name");
  if (!WORKFLOW_NAME_RE.test(name)) {
    throw new Error("Workflow name must be lowercase kebab-case");
  }
  if (name !== stem) {
    throw new Error(`Workflow name "${name}" must match filename "${stem}"`);
  }

  const enabled = booleanField(fm, "enabled");
  const ownerSlackUserIds = stringArrayField(fm, "ownerSlackUserIds");
  for (const userId of ownerSlackUserIds) {
    if (!SLACK_USER_RE.test(userId)) {
      throw new Error(`Invalid owner Slack user ID: ${userId}`);
    }
  }

  const triggers = parseTriggers(requiredArray(fm, "triggers"), options.builtInCommands ?? new Set());
  const outputs = parseOutputs(requiredArray(fm, "outputs"), name);
  const permissions = parsePermissions(
    objectRecord(fm.permissions, "permissions"),
    options.repos,
  );
  validateOutputsAgainstPermissions(outputs, permissions);

  const runner = fm.runner == null
    ? undefined
    : parseRunner(objectRecord(fm.runner, "runner"));
  const fallback = fm.fallback == null
    ? undefined
    : parseFallback(objectRecord(fm.fallback, "fallback"));
  if (runner && !fallback) {
    throw new Error("fallback is required when runner is configured");
  }

  const concurrency = parseConcurrency(fm.concurrency);
  const description =
    fm.description == null ? undefined : stringValue(fm.description, "description");

  return {
    name,
    enabled,
    description,
    ownerSlackUserIds,
    triggers,
    outputs,
    runner,
    permissions,
    fallback,
    concurrency,
    prompt: options.body.trim(),
    versionHash: hashContent(options.content),
    sourcePath: options.path,
    sourceRoot: options.sourceRoot,
  };
}

function parseFrontmatter(content: string, path: string): {
  frontmatter: unknown;
  body: string;
} {
  if (!content.startsWith("---")) {
    throw new Error(`Workflow file is missing YAML frontmatter: ${path}`);
  }
  const end = content.indexOf("\n---", 3);
  if (end === -1) {
    throw new Error(`Workflow file has unterminated frontmatter: ${path}`);
  }
  const yaml = content.slice(3, end).trim();
  const body = content.slice(end + "\n---".length);
  return { frontmatter: parseYaml(yaml), body };
}

function parseTriggers(raw: unknown[], builtInCommands: Set<string>): WorkflowTrigger[] {
  if (raw.length === 0) throw new Error("triggers must contain at least one entry");
  return raw.map((entry, index) => {
    const trigger = objectRecord(entry, `triggers[${index}]`);
    const type = stringField(trigger, "type");
    if (type === "schedule") {
      const cron = stringField(trigger, "cron");
      const timezone = stringField(trigger, "timezone");
      validateCron(cron, timezone);
      return { type, cron, timezone };
    }
    if (type === "command") {
      const command = stringField(trigger, "command");
      if (!COMMAND_RE.test(command)) {
        throw new Error(`Invalid workflow command: ${command}`);
      }
      if (builtInCommands.has(command)) {
        throw new Error(`Workflow command collides with built-in command: ${command}`);
      }
      return { type, command };
    }
    if (type === "slack-event") {
      const channel = stringField(trigger, "channel");
      validateSlackChannel(channel);
      const pattern = trigger.pattern == null
        ? undefined
        : stringValue(trigger.pattern, "pattern");
      if (pattern) {
        try {
          new RegExp(pattern);
        } catch (err) {
          throw new Error(`Invalid slack-event pattern: ${(err as Error).message}`);
        }
      }
      return { type, channel, pattern };
    }
    throw new Error(`Unsupported trigger type: ${type}`);
  });
}

function parseOutputs(raw: unknown[], workflowName: string): WorkflowOutput[] {
  if (raw.length === 0) throw new Error("outputs must contain at least one entry");
  return raw.map((entry, index) => {
    const output = objectRecord(entry, `outputs[${index}]`);
    const type = stringField(output, "type");
    if (type === "docs") {
      const path = stringField(output, "path");
      const normalizedPath = normalizeWorkflowPath(path);
      const prefix = `${WORKFLOW_ARTIFACT_ROOT}/${workflowName}`;
      if (normalizedPath !== prefix && !normalizedPath.startsWith(`${prefix}/`)) {
        throw new Error(`docs output path must stay under ${prefix}`);
      }
      return { type, path: normalizedPath };
    }
    if (type === "slack") {
      const channel = stringField(output, "channel");
      validateSlackChannel(channel);
      const threadTs = output.threadTs == null
        ? null
        : stringValue(output.threadTs, "threadTs");
      return { type, channel, threadTs };
    }
    if (type === "slack-thread") {
      const channel = stringField(output, "channel");
      validateSlackChannel(channel);
      return { type, channel };
    }
    throw new Error(`Unsupported output type: ${type}`);
  });
}

function normalizeWorkflowPath(path: string): string {
  if (isAbsolute(path)) throw new Error("workflow paths must be relative");
  const normalizedPath = normalize(path).replace(/\\/g, "/");
  if (normalizedPath === ".." || normalizedPath.startsWith("../")) {
    throw new Error("workflow paths must not traverse outside the project");
  }
  return normalizedPath;
}

function parseRunner(raw: Record<string, unknown>): WorkflowRunnerConfig {
  const provider = stringField(raw, "provider");
  if (provider !== "default" && provider !== "opencode" && provider !== "claude") {
    throw new Error(`Invalid runner provider: ${provider}`);
  }
  const timeoutMs = raw.timeoutMs == null ? undefined : positiveNumber(raw.timeoutMs, "timeoutMs");
  return {
    provider,
    agentName: stringField(raw, "agentName"),
    timeoutMs,
    model: raw.model == null ? undefined : stringValue(raw.model, "model"),
  };
}

function parsePermissions(
  raw: Record<string, unknown>,
  repos: RepoConfig[],
): WorkflowPermissions {
  const tools = stringArrayField(raw, "tools") as WorkflowTool[];
  if (tools.length === 0) throw new Error("permissions.tools must not be empty");
  for (const tool of tools) {
    if (!SUPPORTED_TOOLS.has(tool)) throw new Error(`Unsupported workflow tool: ${tool}`);
  }
  const repoNames = new Set(repos.map((repo) => repo.name));
  const declaredRepos = raw.repos == null ? undefined : stringArrayField(raw, "repos");
  if (declaredRepos) {
    for (const repo of declaredRepos) {
      if (!repoNames.has(repo)) throw new Error(`Unknown workflow repo permission: ${repo}`);
    }
  }
  return { tools, repos: declaredRepos };
}

function validateOutputsAgainstPermissions(
  outputs: WorkflowOutput[],
  permissions: WorkflowPermissions,
): void {
  const tools = new Set(permissions.tools);
  for (const output of outputs) {
    if (output.type === "docs" && !tools.has("docs.write")) {
      throw new Error("docs output requires docs.write permission");
    }
    if ((output.type === "slack" || output.type === "slack-thread") && !tools.has("slack.post")) {
      throw new Error("slack output requires slack.post permission");
    }
  }
}

function parseFallback(raw: Record<string, unknown>): { mode: "deterministic-summary" } {
  const mode = stringField(raw, "mode");
  if (mode !== "deterministic-summary") {
    throw new Error(`Unsupported fallback mode: ${mode}`);
  }
  return { mode };
}

function parseConcurrency(raw: unknown): WorkflowConcurrency {
  if (raw == null) return "skip";
  const value = stringValue(raw, "concurrency");
  if (value === "skip" || value === "parallel") return value;
  throw new Error(`Invalid concurrency: ${value}`);
}

function validateCron(cron: string, timezone: string): void {
  try {
    CronExpressionParser.parse(cron, { tz: timezone });
  } catch (err) {
    throw new Error(`Invalid schedule trigger: ${(err as Error).message}`);
  }
}

function validateSlackChannel(channel: string): void {
  if (!SLACK_CHANNEL_RE.test(channel)) {
    throw new Error(`Invalid Slack channel ID: ${channel}`);
  }
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredArray(value: Record<string, unknown>, key: string): unknown[] {
  const raw = value[key];
  if (!Array.isArray(raw)) throw new Error(`${key} must be an array`);
  return raw;
}

function stringArrayField(value: Record<string, unknown>, key: string): string[] {
  const raw = value[key];
  if (!Array.isArray(raw)) throw new Error(`${key} must be an array`);
  return raw.map((entry, index) => stringValue(entry, `${key}[${index}]`));
}

function stringField(value: Record<string, unknown>, key: string): string {
  return stringValue(value[key], key);
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function booleanField(value: Record<string, unknown>, key: string): boolean {
  if (typeof value[key] !== "boolean") throw new Error(`${key} must be boolean`);
  return value[key] as boolean;
}

function positiveNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return value;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
