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
  it("denies edit/write/bash for read-only roles", () => {
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
      bash: "deny",
      task: "deny",
      read: "allow",
    });
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

    // Review / reproducer: hard read-only where enforceable.
    for (const name of ["review", "reproducer"] as const) {
      const row = byName.get(name)!;
      expect(row.intent).toBe("read-only");
      expect(row.claudePermissionMode).toBe("plan");
      expect(row.codexSandbox).toBe("read-only");
      expect(row.openCode).toMatchObject({ edit: "deny", write: "deny" });
    }

    // PM / architect: human-gated. Codex gets a read-only jail — with
    // workspace-write + on-request, ordinary edits never trigger an approval,
    // so the gate would be advisory. Mutations must be explicit escalations.
    for (const name of ["pm", "architect"] as const) {
      const row = byName.get(name)!;
      expect(row.intent).toBe("human-gated");
      expect(row.claudePermissionMode).toBe("plan");
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
