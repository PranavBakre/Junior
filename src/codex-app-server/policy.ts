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

/**
 * Maps a Junior agent's permission *intent* onto the Codex app-server
 * approval/sandbox surface. Intent resolution is provider-neutral
 * (`resolveEffectivePermissionIntent` → trusted catalog). Prefer
 * `compileCodexPolicy` from `src/runners/policy.ts` as the shared entry point.
 */
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
    // Read-only sandbox, NOT workspace-write: with a writable workspace and
    // `on-request`, ordinary in-workspace edits never trigger an approval —
    // the sandbox permits them and the model only asks when IT chooses. A
    // read-only jail makes every mutation an explicit escalation request,
    // which is the human gate this intent advertises.
    return {
      approvalPolicy: "on-request",
      sandbox: "read-only",
      sandboxPolicy: { type: "readOnly" },
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
