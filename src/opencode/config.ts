export type OpenCodePermissionConfig = string | Record<string, unknown>;
type OpenCodeAgentPermissionConfig = Record<string, unknown>;
type OpenCodeAgentMode = "primary" | "subagent";

export interface OpenCodeMcpEntry {
  type?: string;
  enabled?: boolean;
  command?: string[];
  url?: string;
  [key: string]: unknown;
}

export type OpenCodeMcpConfig = Record<string, OpenCodeMcpEntry>;

export interface BuildOpenCodeConfigOptions {
  agentName: string;
  agentPrompt: string;
  model?: string | null;
  permission?: OpenCodePermissionConfig;
  description?: string;
  mcp?: OpenCodeMcpConfig | null;
  subagents?: OpenCodeSubagentConfig[];
}

export interface OpenCodeSubagentConfig {
  name: string;
  prompt: string;
  description?: string;
  permission?: OpenCodePermissionConfig;
}

export interface OpenCodeGeneratedAgentConfig {
  description: string;
  mode: OpenCodeAgentMode;
  permission: OpenCodeAgentPermissionConfig;
  prompt: string;
}

export interface OpenCodeGeneratedConfig {
  $schema: string;
  model?: string;
  permission: OpenCodePermissionConfig;
  agent: Record<string, OpenCodeGeneratedAgentConfig>;
  mcp?: OpenCodeMcpConfig;
}

export function buildOpenCodeConfig(
  options: BuildOpenCodeConfigOptions,
): OpenCodeGeneratedConfig {
  const primaryAgentName = options.agentName.trim();
  if (!primaryAgentName) {
    throw new Error("OpenCode agentName is required");
  }

  const config: OpenCodeGeneratedConfig = {
    $schema: "https://opencode.ai/config.json",
    permission: options.permission ?? "allow",
    agent: {
      [primaryAgentName]: {
        description: options.description ?? "Junior Slack runner",
        mode: "primary",
        permission: toAgentPermissionConfig(options.permission ?? "allow"),
        prompt: options.agentPrompt,
      },
    },
  };

  for (const subagent of options.subagents ?? []) {
    const name = subagent.name.trim();
    if (!name) {
      throw new Error("OpenCode subagent name is required");
    }
    if (name === primaryAgentName) {
      throw new Error(`OpenCode subagent "${name}" conflicts with primary agent`);
    }
    if (config.agent[name]) {
      throw new Error(`Duplicate OpenCode subagent "${name}"`);
    }

    config.agent[name] = {
      description: subagent.description ?? `Junior support subagent: ${name}`,
      mode: "subagent",
      permission: toAgentPermissionConfig(
        subagent.permission ?? options.permission ?? "allow",
      ),
      prompt: subagent.prompt,
    };
  }

  if (options.model) {
    config.model = options.model;
  }

  if (options.mcp && Object.keys(options.mcp).length > 0) {
    config.mcp = options.mcp;
  }

  return config;
}

export function buildOpenCodeConfigContent(
  options: BuildOpenCodeConfigOptions,
): string {
  return JSON.stringify(buildOpenCodeConfig(options));
}

function toAgentPermissionConfig(
  permission: OpenCodePermissionConfig,
): OpenCodeAgentPermissionConfig {
  if (typeof permission === "string") {
    return { "*": permission };
  }
  return permission;
}
