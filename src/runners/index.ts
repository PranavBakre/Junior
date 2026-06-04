import type { Config } from "../config.ts";
import type { AgentIdentity, RunnerProvider, ThreadSession } from "../session/types.ts";
import { spawnClaude } from "../claude/spawner.ts";
import { spawnOpenCode } from "../opencode/spawner.ts";
import { spawnOpenCodeSdk } from "../opencode/sdk-provider.ts";
import { spawnCodexAppServer } from "../codex-app-server/spawner.ts";
import type { OpenCodeMcpConfig } from "../opencode/config.ts";
import type { SpawnHandle } from "./types.ts";
import {
  mixpanelMcpCommand,
  mongoMcpUrl,
  playwrightMcpCommand,
  slackMcpUrl,
  wantsMcp,
} from "./mcp-config.ts";

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
    case "opencode-sdk":
      return config.opencode.timeoutMs;
    case "codex-app-server":
      return config.codex.timeoutMs;
    case "claude":
    case "codex":
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
        continuityEnabled: config.opencode.continuityEnabled,
        permission: config.opencode.permission,
        mcp: buildOpenCodeMcpConfig(config, session),
      },
      targetRepoCwd,
      botToken,
      agentIdentity,
      imagePaths,
    );
  }

  if (provider === "opencode-sdk") {
    return spawnOpenCodeSdk(
      session,
      prompt,
      config,
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

  if (provider === "codex-app-server") {
    return spawnCodexAppServer(
      session,
      prompt,
      config,
      targetRepoCwd,
      botToken,
      agentIdentity,
      imagePaths,
    );
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
  if (config.opencode.slackMcpEnabled && wantsMcp(session, "slack-bot")) {
    mcp["slack-bot"] = {
      type: "remote",
      url: slackMcpUrl(session),
      enabled: true,
    };
  }
  if (config.opencode.playwrightMcpEnabled && wantsMcp(session, "playwright")) {
    const command = playwrightMcpCommand();
    mcp.playwright = {
      type: "local",
      command: [command.command, ...command.args],
      enabled: true,
    };
  }
  if (config.opencode.mixpanelMcpEnabled && wantsMcp(session, "mixpanel") && isFeatureMetricsSession(session)) {
    const command = mixpanelMcpCommand();
    mcp.mixpanel = {
      type: "local",
      command: [command.command, ...command.args],
      enabled: true,
    };
  }
  if (config.opencode.mongodbMcpEnabled && wantsMcp(session, "mongodb")) {
    mcp.mongodb = {
      type: "remote",
      url: mongoMcpUrl(session),
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
