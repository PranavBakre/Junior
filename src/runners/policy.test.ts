import { describe, expect, it } from "bun:test";
import {
  buildPermissionMatrix,
  CATALOG_ROLE_NAMES,
  compileOpenCodePermission,
  effectiveIntentAgainstCatalog,
  resolveRunPermissionIntent,
} from "./policy.ts";

const claudeConfig = {
  maxTurns: 10,
  timeoutMs: 300_000,
  permissionMode: "acceptEdits",
  defaultModel: null,
  defaultDriver: "headless" as const,
  tmuxIdleTtlMs: 0,
  tmuxSweepIntervalMs: 0,
};

const codexConfig = {
  mode: "app-server" as const,
  model: null,
  timeoutMs: 300_000,
  sandbox: "workspace-write" as const,
  askForApproval: "never" as const,
  searchEnabled: false,
  appServerContinuityEnabled: false,
  mcpEnabled: true,
  slackMcpEnabled: true,
  playwrightMcpEnabled: true,
  mixpanelMcpEnabled: true,
  mongodbMcpEnabled: true,
  memoryMcpEnabled: true,
  isolatedHomePath: "data/codex-home",
};

describe("compileOpenCodePermission", () => {
  it("allows only non-mutating inspection for reviewers without a worktree", () => {
    const permission = compileOpenCodePermission({
      subject: {
        activeAgentName: "review",
        agentPermissions: { intent: null, mcp: [], tools: [] },
      },
      fallback: "allow",
    });
    expect(permission).toMatchObject({
      edit: "deny",
      write: "deny",
      task: "deny",
      read: "allow",
    });
    expect((permission as Record<string, unknown>).bash).toMatchObject({
      "*": "deny",
      "gh pr view *": "allow",
      "git blame *": "allow",
    });
    expect((permission as Record<string, unknown>).bash).not.toMatchObject({
      "git fetch *": "allow",
      "gh pr checkout *": "allow",
    });
  });

  it("allows only verification bash patterns for review worktrees", () => {
    const permission = compileOpenCodePermission({
      subject: {
        activeAgentName: "review",
        worktreePath: "/repo.junior-worktrees/slack-t",
        verificationPackageManager: "npm",
        agentPermissions: { intent: "read-only", mcp: [], tools: [] },
      },
      cwd: "/repo.junior-worktrees/slack-t",
    }) as Record<string, unknown>;

    expect(permission.edit).toBe("deny");
    expect(permission.write).toBe("deny");
    expect(permission.bash).toMatchObject({
      "*": "deny",
      "npm test *": "allow",
      "git fetch *": "allow",
    });
    expect(permission.bash).not.toMatchObject({ "gh pr checkout *": "allow" });
    expect(permission.bash).not.toMatchObject({ "pnpm test *": "allow" });
    expect(permission.bash).not.toMatchObject({ "bun test *": "allow" });
    expect(permission.bash).not.toMatchObject({ "npm install *": "allow" });
  });

  it("keeps read-only inspection when a review worktree has no detected manager", () => {
    const permission = compileOpenCodePermission({
      subject: {
        activeAgentName: "review",
        worktreePath: "/repo.junior-worktrees/slack-t",
        agentPermissions: { intent: "read-only", mcp: [], tools: [] },
      },
      cwd: "/repo.junior-worktrees/slack-t",
    }) as Record<string, unknown>;

    expect(permission.bash).toMatchObject({
      "*": "deny",
      "git blame *": "allow",
      "gh pr list *": "allow",
    });
    expect(
      Object.keys(permission.bash as Record<string, string>).some((pattern) =>
        pattern.startsWith("gh api")
      ),
    ).toBe(false);
    expect(permission.bash).not.toMatchObject({ "npm test *": "allow" });
  });

  it("withholds worktree mutations and checks when cwd is outside the registered worktree", () => {
    const permission = compileOpenCodePermission({
      subject: {
        activeAgentName: "review",
        worktreePath: "/repo.junior-worktrees/slack-t",
        verificationPackageManager: "npm",
        agentPermissions: { intent: "read-only", mcp: [], tools: [] },
      },
      cwd: "/shared/repo",
    }) as Record<string, unknown>;

    expect(permission.bash).toMatchObject({
      "*": "deny",
      "gh pr view *": "allow",
      "git blame *": "allow",
    });
    expect(permission.bash).not.toMatchObject({
      "git fetch *": "allow",
      "gh pr checkout *": "allow",
      "npm test *": "allow",
    });
  });

  it("uses an explicit read-safe MCP allowlist for read-only roles", () => {
    const permission = compileOpenCodePermission({
      subject: {
        activeAgentName: "review",
        agentPermissions: { intent: "read-only", mcp: [], tools: [] },
      },
    }) as Record<string, string>;
    expect(permission["mcp__*"]).toBe("deny");
    expect(permission["mcp__slack-bot__memory_recall"]).toBe("allow");
    expect(permission["mcp__slack-bot__slack_read_thread"]).toBe("allow");
    expect(permission["mcp__slack-bot__github_read_pr_review_state"]).toBe("allow");
    expect(permission["mcp__slack-bot__github_post_review"]).toBe("allow");
    // Control-plane transitions are explicitly capability-scoped, not blanket MCP.
    expect(permission["mcp__slack-bot__agent_dispatch"]).toBe("allow");
    expect(permission["mcp__slack-bot__pipeline_report_outcome"]).toBe("allow");
    expect(permission["mcp__slack-bot__memory_add"]).not.toBe("allow");
  });

  it("does not grant GitHub review writes to the reproducer", () => {
    const permission = compileOpenCodePermission({
      subject: {
        activeAgentName: "reproducer",
        agentPermissions: { intent: "read-only", mcp: [], tools: [] },
      },
    }) as Record<string, string>;
    expect(permission["mcp__slack-bot__github_post_review"]).not.toBe("allow");
    expect(permission["mcp__*"]).toBe("deny");
  });

  it("asks on mutating tools for human-gated roles", () => {
    const permission = compileOpenCodePermission({
      subject: {
        activeAgentName: "pm",
        agentPermissions: { intent: null, mcp: [], tools: [] },
      },
    });
    expect(permission).toMatchObject({
      edit: "ask",
      write: "ask",
      bash: "ask",
      task: "deny",
    });
  });

  it("uses fallback for normal builders", () => {
    expect(
      compileOpenCodePermission({
        subject: {
          activeAgentName: "build",
          agentPermissions: { intent: null, mcp: [], tools: [] },
        },
        fallback: "allow",
      }),
    ).toBe("allow");
  });

  it("hard-denies everything for no-tools", () => {
    const permission = compileOpenCodePermission({
      subject: {
        activeAgentName: "review",
        agentPermissions: { intent: "no-tools", mcp: [], tools: [] },
      },
    });
    expect(permission).toMatchObject({
      "*": "deny",
      bash: "deny",
      edit: "deny",
    });
  });
});

describe("provider permission compilation matrix", () => {
  it("resolves every catalog role consistently across providers", () => {
    const matrix = buildPermissionMatrix({
      claudeConfig,
      codexConfig,
      openCodeFallback: "allow",
    });

    const byName = new Map(matrix.map((row) => [row.agentName, row]));
    for (const name of CATALOG_ROLE_NAMES) {
      expect(byName.has(name)).toBe(true);
    }

    // Review / reproducer: hard read-only where enforceable. Both use Claude
    // default mode so the trusted pipeline-control MCP allowlist can settle
    // assignments; repository mutations remain explicitly denied.
    for (const name of ["review", "reproducer"] as const) {
      const row = byName.get(name)!;
      expect(row.intent).toBe("read-only");
      expect(row.claudePermissionMode).toBe("default");
      expect(row.codexSandbox).toBe("read-only");
      expect(row.openCode).toMatchObject({ edit: "deny", write: "deny" });
    }

    // PM / architect: human-gated. Codex gets a read-only jail — with
    // workspace-write + on-request, ordinary edits never trigger an approval,
    // so the gate would be advisory. Mutations must be explicit escalations.
    for (const name of ["pm", "architect"] as const) {
      const row = byName.get(name)!;
      expect(row.intent).toBe("human-gated");
      expect(row.claudePermissionMode).toBe("default");
      expect(row.codexSandbox).toBe("read-only");
      expect(row.openCode).toMatchObject({ edit: "ask", write: "ask" });
    }

    // Builders / orchestrators: ordinary scoped work, no merge grant in intent.
    for (const name of ["build", "frontend", "default", "lead"] as const) {
      const row = byName.get(name)!;
      expect(row.intent).toBe("normal");
      expect(row.claudePermissionMode).toBe("bypassPermissions");
      // Uses configured codex sandbox (workspace-write default).
      expect(row.codexSandbox).toBe("workspace-write");
      expect(row.openCode).toBe("allow");
    }
  });

  it("clamps target-repo widen attempts in the compiler path", () => {
    expect(effectiveIntentAgainstCatalog("review", "normal")).toBe("read-only");
    expect(effectiveIntentAgainstCatalog("reproducer", "normal")).toBe(
      "read-only",
    );
    expect(effectiveIntentAgainstCatalog("pm", "normal")).toBe("human-gated");
    // Narrowing is allowed.
    expect(effectiveIntentAgainstCatalog("build", "read-only")).toBe(
      "read-only",
    );
  });

  it("resolveRunPermissionIntent uses catalog when frontmatter missing", () => {
    expect(
      resolveRunPermissionIntent({
        activeAgentName: "review",
        agentPermissions: { intent: null, mcp: [], tools: [] },
      }),
    ).toBe("read-only");
    expect(
      resolveRunPermissionIntent({
        activeAgentName: "architect",
        agentPermissions: { intent: null, mcp: [], tools: [] },
      }),
    ).toBe("human-gated");
    expect(
      resolveRunPermissionIntent({
        activeAgentName: "build",
        agentPermissions: { intent: null, mcp: [], tools: [] },
      }),
    ).toBe("normal");
  });
});
