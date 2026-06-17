import type { Config } from "../config.ts";
import type { AgentPermissions } from "../agents/loader.ts";
import type { ThreadSession } from "../session/types.ts";

/**
 * Claude-runner mirror of `mapCodexRunPolicy` (`src/codex-app-server/policy.ts`).
 *
 * Maps a Junior agent's permission *intent* onto the `claude -p` CLI permission
 * surface: `--permission-mode`, `--allowedTools`, `--disallowedTools`, and
 * `--add-dir`.
 *
 * Unlike Codex, Claude Code has NO OS-level sandbox. There is no read-only /
 * workspace-write filesystem jail to lean on, so confinement here is purely
 * tool-based (allow/deny lists + permission mode) plus the working directory
 * we hand it. Write lockdown for read-only/no-tools agents is therefore
 * enforced by explicitly disallowing the mutating tools, not by a sandbox.
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

export function mapClaudeRunPolicy(options: {
  config: Config["claude"];
  session: ThreadSession;
  cwd: string;
}): ClaudeRunPolicy {
  const { config, session, cwd } = options;
  const permissions: AgentPermissions | undefined = session.agentPermissions;
  const intent = permissions?.intent ?? null;
  const declaredTools = permissions?.tools ?? [];

  if (intent === "read-only") {
    // Critical safety case: review / reproducer-validation agents must not
    // be able to mutate the worktree. `plan` mode is the ACTUAL gate — it
    // blocks edits and write-Bash wholesale; the deny list below is
    // defense-in-depth for specific high-blast-radius commands, not the
    // primary enforcer. Don't loosen plan mode assuming the deny list confines.
    return {
      permissionMode: "plan",
      allowedTools: declaredTools,
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
    return {
      permissionMode: "plan",
      allowedTools: declaredTools,
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
