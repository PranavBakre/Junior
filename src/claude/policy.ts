import type { Config } from "../config.ts";
import {
  resolveEffectivePermissionIntent,
  type AgentPermissions,
} from "../agents/loader.ts";
import type { ThreadSession } from "../session/types.ts";
import { hasCapability } from "../agents/capabilities.ts";
import { worktreeVerificationCommandPatterns } from "../agents/verification.ts";
import { GITHUB_POST_REVIEW_TOOL } from "../github/review-comments.ts";

/**
 * Claude-runner mirror of `mapCodexRunPolicy` (`src/codex-app-server/policy.ts`).
 *
 * Maps a Junior agent's permission *intent* onto the `claude -p` CLI permission
 * surface: `--permission-mode`, `--allowedTools`, `--disallowedTools`, and
 * `--add-dir`.
 *
 * Intent resolution is provider-neutral (`resolveEffectivePermissionIntent` →
 * trusted catalog ceiling in `src/agents/registry.ts`). Prefer
 * `compileClaudePolicy` from `src/runners/policy.ts` as the shared entry point.
 *
 * Unlike Codex, Claude Code has NO OS-level sandbox. There is no read-only /
 * workspace-write filesystem jail to lean on, so confinement here is purely
 * tool-based (allow/deny lists + permission mode) plus the working directory
 * we hand it. Write lockdown for read-only/no-tools agents is therefore
 * enforced by explicitly disallowing the mutating tools, not by a sandbox.
 * Do not claim worktree confinement Claude cannot enforce.
 *
 * Pure function — no IO.
 */
export interface ClaudeRunPolicy {
  permissionMode: string;
  allowedTools: string[];
  disallowedTools: string[];
  addDirs: string[];
}

/** Mutating tools we strip for read-only agents. */
const READ_ONLY_DISALLOWED = [
  "Edit",
  "Write",
  "NotebookEdit",
  "Bash(rm *)",
  "Bash(git push *)",
];

/** Hardest lockdown — no edits and no shell at all. */
const NO_TOOLS_DISALLOWED = ["Edit", "Write", "NotebookEdit", "Bash"];

/**
 * True for tool specifiers that can mutate state: file editors and any Bash
 * pattern (Bash(git *) can commit/push — command patterns don't make it safe).
 */
function isMutatingToolSpec(spec: string): boolean {
  const name = spec.trim();
  return (
    name === "Edit" ||
    name === "Write" ||
    name === "NotebookEdit" ||
    name === "Bash" ||
    name.startsWith("Bash(")
  );
}

export function mapClaudeRunPolicy(options: {
  config: Config["claude"];
  session: ThreadSession;
  cwd: string;
}): ClaudeRunPolicy {
  const { config, session, cwd } = options;
  const permissions: AgentPermissions | undefined = session.agentPermissions;
  const intent = resolveEffectivePermissionIntent(
    permissions,
    session.activeAgentName ?? session.agentType,
  );
  const declaredTools = permissions?.tools ?? [];
  const agentName = session.activeAgentName ?? session.agentType;
  const capabilityTools = hasCapability(
    agentName,
    "github-review-comment",
  )
    ? [GITHUB_POST_REVIEW_TOOL]
    : [];
  const worktreeRoots = [
    session.worktreePath,
    ...Object.values(session.worktreePaths ?? {}),
  ].filter((root): root is string => Boolean(root));
  const mayVerifyWorktree =
    hasCapability(agentName, "worktree-verify") &&
    worktreeRoots.includes(cwd) &&
    Boolean(session.verificationPackageManager);

  if (intent === "read-only") {
    if (mayVerifyWorktree) {
      const readOnlyDeclaredTools = declaredTools.filter(
        (tool) => !isMutatingToolSpec(tool),
      );
      const verificationTools = worktreeVerificationCommandPatterns(
        session.verificationPackageManager!,
      ).map((pattern) => `Bash(${pattern})`);
      return {
        // Headless default mode denies commands that are neither explicitly
        // allowed nor approved. Review has no approval round-trip, so this is
        // a strict allowlist rather than a route to arbitrary shell.
        permissionMode: "default",
        allowedTools: [
          ...new Set([
            ...readOnlyDeclaredTools,
            ...capabilityTools,
            ...verificationTools,
          ]),
        ],
        disallowedTools: [...READ_ONLY_DISALLOWED],
        addDirs: [
          ...new Set([
            cwd,
            ...worktreeRoots,
          ]),
        ],
      };
    }
    // Critical safety case: review / reproducer-validation agents must not
    // be able to mutate the worktree. `plan` mode is the ACTUAL gate — it
    // blocks edits and write-Bash wholesale; the deny list below is
    // defense-in-depth for specific high-blast-radius commands, not the
    // primary enforcer. Don't loosen plan mode assuming the deny list confines.
    return {
      permissionMode: "plan",
      allowedTools: [...new Set([...declaredTools, ...capabilityTools])],
      disallowedTools: [...READ_ONLY_DISALLOWED],
      addDirs: [],
    };
  }

  if (intent === "no-tools") {
    return {
      permissionMode: "plan",
      allowedTools: [],
      disallowedTools: [...NO_TOOLS_DISALLOWED],
      addDirs: [],
    };
  }

  if (intent === "human-gated") {
    // Propose, don't execute. A later phase layers live approval on top; the
    // policy module's safe base is `plan`.
    //
    // Mutating tools MUST NOT be pre-allowed: when the approval round-trip is
    // active the spawner switches to `default` mode, and anything in
    // --allowedTools skips the permission prompt entirely — a declared
    // Write/Edit would silently bypass the human gate it exists for. Leaving
    // them un-allowed routes each mutation through the approval tool
    // (approval mode) or blocks it (plan mode).
    return {
      permissionMode: "plan",
      allowedTools: declaredTools.filter((tool) => !isMutatingToolSpec(tool)),
      disallowedTools: [],
      addDirs: [cwd],
    };
  }

  if (intent === "utility") {
    // Preserve configured behavior for utility commands.
    return {
      permissionMode: config.permissionMode,
      allowedTools: declaredTools,
      disallowedTools: [],
      addDirs: [cwd],
    };
  }

  // "normal" and null/unset: build agents need full bash to run tests/builds.
  // Claude has no OS sandbox, so they run broadly, confined only by the
  // worktree cwd (accepted trade-off). bypassPermissions makes an allow-list
  // redundant.
  return {
    permissionMode: "bypassPermissions",
    allowedTools: [],
    disallowedTools: [],
    addDirs: [cwd],
  };
}
