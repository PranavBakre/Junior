import type { Config } from "../config.ts";
import type { AgentIdentity, RunnerProvider, ThreadSession } from "../session/types.ts";
import { spawnClaude } from "../claude/spawner.ts";
import { spawnOpenCode } from "../opencode/spawner.ts";
import { spawnOpenCodeSdk } from "../opencode/sdk-provider.ts";
import { spawnCodexAppServer } from "../codex-app-server/spawner.ts";
import type { SpawnHandle } from "./types.ts";
import {
  buildOpenCodeMcpConfig,
} from "./mcp-config.ts";
import { compileOpenCodePermission } from "./policy.ts";
import { resolveRunnerCwd } from "./runtime.ts";

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
  githubAuthEnv?: Record<string, string>,
): SpawnHandle {
  const provider = sessionProvider(session, config);

  if (provider === "opencode") {
    return spawnOpenCode(
      session,
      prompt,
      {
        defaultModel: config.opencode.model,
        continuityEnabled: config.opencode.continuityEnabled,
        // Prefer catalog/session intent when present; fall back to operator config.
        permission: compileOpenCodePermission({
          subject: session,
          cwd: resolveRunnerCwd(session, targetRepoCwd),
          fallback: config.opencode.permission,
        }),
        mcp: buildOpenCodeMcpConfig(config, session),
      },
      targetRepoCwd,
      botToken,
      agentIdentity,
      imagePaths,
      githubAuthEnv,
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
      githubAuthEnv,
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
      githubAuthEnv,
    );
  }

  return spawnClaude(
    session,
    prompt,
    config.claude,
    targetRepoCwd,
    botToken,
    agentIdentity,
    githubAuthEnv,
  );
}

export { buildOpenCodeMcpConfig } from "./mcp-config.ts";
