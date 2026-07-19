import type { Config } from "../config.ts";
import {
  resolveEffectivePermissionIntent,
  type AgentPermissions,
} from "../agents/loader.ts";
import type { ThreadSession } from "../session/types.ts";

export type CodexApprovalPolicy = "untrusted" | "on-request" | "never";
export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";

export interface CodexSandboxPolicy {
  type: "readOnly" | "workspaceWrite" | "dangerFullAccess";
  writableRoots?: string[];
  networkAccess?: boolean;
  excludeTmpdirEnvVar?: boolean;
  excludeSlashTmp?: boolean;
}

export interface CodexRunPolicy {
  approvalPolicy: CodexApprovalPolicy;
  sandbox: CodexSandbox;
  sandboxPolicy: CodexSandboxPolicy;
  mcpAllowed: boolean;
}

export function mapCodexRunPolicy(options: {
  config: Config["codex"];
  session: ThreadSession;
  cwd: string;
}): CodexRunPolicy {
  const { config, session, cwd } = options;
  const permissions: AgentPermissions | undefined = session.agentPermissions;
  const intent = resolveEffectivePermissionIntent(
    permissions,
    session.activeAgentName ?? session.agentType,
  );

  if (intent === "read-only" || intent === "no-tools") {
    return {
      approvalPolicy: "on-request",
      sandbox: "read-only",
      sandboxPolicy: { type: "readOnly" },
      mcpAllowed: intent !== "no-tools" && !session.cwd,
    };
  }

  if (intent === "human-gated") {
    return {
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      sandboxPolicy: workspaceWritePolicy(cwd),
      mcpAllowed: !session.cwd,
    };
  }

  if (intent === "utility") {
    return {
      approvalPolicy: config.askForApproval,
      sandbox: config.sandbox,
      sandboxPolicy: sandboxPolicyFor(config.sandbox, cwd),
      mcpAllowed: permissions?.mcp.length ? !session.cwd : false,
    };
  }

  return {
    approvalPolicy: config.askForApproval,
    sandbox: config.sandbox,
    sandboxPolicy: sandboxPolicyFor(config.sandbox, cwd),
    mcpAllowed: !session.cwd,
  };
}

export function sandboxPolicyFor(
  sandbox: CodexSandbox,
  cwd: string,
): CodexSandboxPolicy {
  if (sandbox === "read-only") return { type: "readOnly" };
  if (sandbox === "danger-full-access") return { type: "dangerFullAccess" };
  return workspaceWritePolicy(cwd);
}

function workspaceWritePolicy(cwd: string): CodexSandboxPolicy {
  return {
    type: "workspaceWrite",
    writableRoots: [cwd],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}
