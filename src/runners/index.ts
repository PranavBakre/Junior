import type { Config } from "../config.ts";
import type { AgentIdentity, RunnerProvider, ThreadSession } from "../session/types.ts";
import { spawnClaude } from "../claude/spawner.ts";
import { spawnOpenCode } from "../opencode/spawner.ts";
import type { OpenCodeMcpConfig } from "../opencode/config.ts";
import type { SpawnHandle } from "./types.ts";

export function sessionProvider(
  session: ThreadSession,
  config: Config,
): RunnerProvider {
  return session.provider ?? config.runner.provider;
}

export function runnerTimeoutMs(
  config: Config,
  provider: RunnerProvider,
): number {
  switch (provider) {
    case "opencode":
      return config.opencode.timeoutMs;
    case "codex":
    case "claude":
      return config.claude.timeoutMs;
  }
}

export function spawnRunner(
  session: ThreadSession,
  prompt: string,
  config: Config,
  targetRepoCwd?: string,
  botToken?: string,
  agentIdentity?: AgentIdentity,
  imagePaths?: string[],
): SpawnHandle {
  const provider = sessionProvider(session, config);

  if (provider === "opencode") {
    return spawnOpenCode(
      session,
      prompt,
      {
        defaultModel: config.opencode.model,
        permission: config.opencode.permission,
        mcp: buildOpenCodeMcpConfig(config, session),
      },
      targetRepoCwd,
      botToken,
      agentIdentity,
      imagePaths,
    );
  }

  if (provider === "codex") {
    // Defense-in-depth: config parsing and !provider reject codex until its
    // adapter lands, but stale persisted state should still fail loudly.
    throw new Error("Codex runner provider is not implemented yet");
  }

  return spawnClaude(
    session,
    prompt,
    config.claude,
    targetRepoCwd,
    botToken,
    agentIdentity,
  );
}

export function buildOpenCodeMcpConfig(
  config: Config,
  session: ThreadSession,
): OpenCodeMcpConfig | null {
  if (!config.opencode.mcpEnabled) return null;

  const mcp: OpenCodeMcpConfig = {};
  if (config.opencode.slackMcpEnabled) {
    mcp["slack-bot"] = {
      type: "remote",
      url: "http://localhost:3456/mcp",
      enabled: true,
    };
  }
  if (config.opencode.playwrightMcpEnabled) {
    mcp.playwright = {
      type: "local",
      command: ["npx", "@playwright/mcp", "--headless"],
      enabled: true,
    };
  }
  if (config.opencode.mixpanelMcpEnabled && isFeatureMetricsSession(session)) {
    mcp.mixpanel = {
      type: "local",
      command: ["npx", "-y", "mcp-remote", "https://mcp.mixpanel.com/mcp"],
      enabled: true,
    };
  }

  return Object.keys(mcp).length > 0 ? mcp : null;
}

function isFeatureMetricsSession(session: ThreadSession): boolean {
  return (
    session.agentType === "feature-metrics" ||
    session.activeAgentName === "feature-metrics"
  );
}
