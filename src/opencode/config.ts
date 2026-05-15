export type OpenCodePermissionConfig = string | Record<string, unknown>;

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
}

export interface OpenCodeGeneratedConfig {
  $schema: string;
  model?: string;
  permission: OpenCodePermissionConfig;
  agent: Record<
    string,
    {
      description: string;
      mode: "primary";
      prompt: string;
    }
  >;
  mcp?: OpenCodeMcpConfig;
}

export function buildOpenCodeConfig(
  options: BuildOpenCodeConfigOptions,
): OpenCodeGeneratedConfig {
  if (!options.agentName.trim()) {
    throw new Error("OpenCode agentName is required");
  }

  const config: OpenCodeGeneratedConfig = {
    $schema: "https://opencode.ai/config.json",
    permission: options.permission ?? "allow",
    agent: {
      [options.agentName]: {
        description: options.description ?? "Junior Slack runner",
        mode: "primary",
        prompt: options.agentPrompt,
      },
    },
  };

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
