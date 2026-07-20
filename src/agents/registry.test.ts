import { describe, expect, it } from "bun:test";
import {
  canEditProductCode,
  canWritePipelineArtifacts,
  checkCapability,
  hasCapability,
  hasHumanGatedCapability,
  isReadOnlyRole,
} from "./capabilities.ts";
import { resolveEffectivePermissionIntent } from "./loader.ts";
import { TRUSTED_AGENT_CATALOG } from "./manifest.ts";
import {
  canonicalAgentName,
  clampPermissionIntent,
  isCatalogAgent,
  isCatalogOrchestrator,
  isTrustedOperationalSource,
  listCatalogAgents,
  registryAllowsHandoff,
  resolveAgentManifest,
  resolveHandoffTarget,
  resolveOrchestratorName,
  trustedOperationalFields,
} from "./registry.ts";

describe("trusted agent catalog", () => {
  it("registers the operational roles", () => {
    const names = listCatalogAgents().map((m) => m.name).sort();
    expect(names).toEqual(
      [
        "architect",
        "build",
        "default",
        "frontend",
        "lead",
        "pm",
        "reproducer",
        "review",
      ].sort(),
    );
  });

  it("resolves aliases and symbolic orchestrator", () => {
    expect(canonicalAgentName("junior")).toBe("default");
    expect(resolveAgentManifest("junior")?.name).toBe("default");
    expect(resolveOrchestratorName("support")).toBe("lead");
    expect(resolveOrchestratorName("default")).toBe("default");
    expect(resolveHandoffTarget("orchestrator", "support")).toBe("lead");
    expect(resolveHandoffTarget("orchestrator", "default")).toBe("default");
  });

  it("resolves pm/architect/build/frontend/review/reproducer consistently", () => {
    for (const name of [
      "pm",
      "architect",
      "build",
      "frontend",
      "review",
      "reproducer",
      "default",
      "lead",
    ]) {
      const manifest = resolveAgentManifest(name);
      expect(manifest).not.toBeNull();
      expect(manifest!.name).toBe(name);
      expect(manifest!.trustSource).toBe("junior");
      expect(manifest!.lifecycle).toBe("persistent");
      expect(manifest!.permissionIntent).toBeTruthy();
    }
  });
});

describe("handoff graph", () => {
  it("encodes the initial handoff edges", () => {
    // pm → architect | build | frontend | orchestrator
    expect(registryAllowsHandoff("pm", "architect")).toBe(true);
    expect(registryAllowsHandoff("pm", "build")).toBe(true);
    expect(registryAllowsHandoff("pm", "frontend")).toBe(true);
    expect(registryAllowsHandoff("pm", "orchestrator", "support")).toBe(true);
    expect(registryAllowsHandoff("pm", "lead", "support")).toBe(true);
    expect(registryAllowsHandoff("pm", "default", "default")).toBe(true);
    expect(registryAllowsHandoff("pm", "review")).toBe(false);

    // architect → build | frontend | orchestrator
    expect(registryAllowsHandoff("architect", "build")).toBe(true);
    expect(registryAllowsHandoff("architect", "frontend")).toBe(true);
    expect(registryAllowsHandoff("architect", "pm")).toBe(false);

    // build ↔ frontend
    expect(registryAllowsHandoff("build", "frontend")).toBe(true);
    expect(registryAllowsHandoff("frontend", "build")).toBe(true);

    // build | frontend → review | orchestrator
    expect(registryAllowsHandoff("build", "review")).toBe(true);
    expect(registryAllowsHandoff("frontend", "review")).toBe(true);

    // review → build | frontend | orchestrator
    expect(registryAllowsHandoff("review", "build")).toBe(true);
    expect(registryAllowsHandoff("review", "frontend")).toBe(true);
    expect(registryAllowsHandoff("review", "reproducer")).toBe(false);

    // reproducer → build | frontend | review | orchestrator
    expect(registryAllowsHandoff("reproducer", "build")).toBe(true);
    expect(registryAllowsHandoff("reproducer", "frontend")).toBe(true);
    expect(registryAllowsHandoff("reproducer", "review")).toBe(true);

    // any role → human escalation
    for (const name of TRUSTED_AGENT_CATALOG.map((m) => m.name)) {
      expect(registryAllowsHandoff(name, "human")).toBe(true);
    }
  });

  it("fails closed for unknown sources", () => {
    expect(registryAllowsHandoff("unknown-agent", "build")).toBe(false);
    expect(registryAllowsHandoff("echo", "review")).toBe(false);
  });

  it("lets orchestrators fan out to workers", () => {
    for (const orch of ["default", "lead", "junior"]) {
      expect(registryAllowsHandoff(orch, "build")).toBe(true);
      expect(registryAllowsHandoff(orch, "review")).toBe(true);
      expect(registryAllowsHandoff(orch, "pm")).toBe(true);
      expect(registryAllowsHandoff(orch, "human")).toBe(true);
    }
  });
});

describe("trust boundaries", () => {
  it("only junior and agents-org may define operational metadata", () => {
    expect(isTrustedOperationalSource("junior")).toBe(true);
    expect(isTrustedOperationalSource("agents-org")).toBe(true);
    expect(isTrustedOperationalSource("target-repo")).toBe(false);
  });

  it("target-repo cannot widen catalog permission intent", () => {
    // review ceiling is read-only — normal would widen
    expect(clampPermissionIntent("review", "normal")).toBe("read-only");
    expect(
      resolveEffectivePermissionIntent(
        { intent: "normal", mcp: [], tools: [] },
        "review",
      ),
    ).toBe("read-only");

    // pm ceiling is human-gated — normal widens, no-tools narrows
    expect(clampPermissionIntent("pm", "normal")).toBe("human-gated");
    expect(clampPermissionIntent("pm", "no-tools")).toBe("no-tools");
    expect(clampPermissionIntent("pm", "read-only")).toBe("read-only");

    // missing intent uses catalog
    expect(clampPermissionIntent("reproducer", null)).toBe("read-only");
    expect(clampPermissionIntent("build", null)).toBe("normal");
    expect(clampPermissionIntent("architect", null)).toBe("human-gated");
  });

  it("unknown agents are not clamped (no catalog ceiling)", () => {
    expect(clampPermissionIntent("echo", "normal")).toBe("normal");
    expect(clampPermissionIntent("unknown", null)).toBeNull();
    expect(
      resolveEffectivePermissionIntent(
        { intent: null, mcp: [], tools: [] },
        "echo",
      ),
    ).toBeNull();
  });

  it("trusted operational fields expose catalog ceilings only", () => {
    const review = trustedOperationalFields("review");
    expect(review).not.toBeNull();
    expect(review!.permissionIntent).toBe("read-only");
    expect(review!.mutationPolicy).toBe("none");
    expect(review!.mayDelegateTo).toContain("build");
    expect(review!.mayDelegateTo).not.toContain("reproducer");
  });
});

describe("capabilities", () => {
  it("review/reproducer are read-only; builders may mutate worktrees", () => {
    expect(isReadOnlyRole("review")).toBe(true);
    expect(isReadOnlyRole("reproducer")).toBe(true);
    expect(canEditProductCode("review")).toBe(false);
    expect(canEditProductCode("reproducer")).toBe(false);
    expect(canEditProductCode("build")).toBe(true);
    expect(canEditProductCode("frontend")).toBe(true);
    expect(canEditProductCode("pm")).toBe(false);
    expect(canWritePipelineArtifacts("pm")).toBe(true);
    expect(canWritePipelineArtifacts("review")).toBe(true);
  });

  it("never grants independently human-gated capabilities", () => {
    expect(hasHumanGatedCapability("default", "merge")).toBe(false);
    expect(hasHumanGatedCapability("build", "production-write")).toBe(false);
    expect(checkCapability("build", "merge").ok).toBe(false);
    expect(hasCapability("build", "worktree-mutate")).toBe(true);
    expect(hasCapability("review", "worktree-mutate")).toBe(false);
    expect(hasCapability("review", "worktree-verify")).toBe(true);
    expect(hasCapability("reproducer", "worktree-verify")).toBe(false);
  });

  it("grants pipeline starts only to trusted orchestrators", () => {
    expect(hasCapability("default", "pipeline-run-start")).toBe(true);
    expect(hasCapability("lead", "pipeline-run-start")).toBe(true);
    expect(hasCapability("junior", "pipeline-run-start")).toBe(true);
    expect(hasCapability("build", "pipeline-run-start")).toBe(false);
    expect(hasCapability("review", "pipeline-run-start")).toBe(false);
  });

  it("classifies orchestrators", () => {
    expect(isCatalogOrchestrator("lead")).toBe(true);
    expect(isCatalogOrchestrator("default")).toBe(true);
    expect(isCatalogOrchestrator("junior")).toBe(true);
    expect(isCatalogOrchestrator("build")).toBe(false);
    expect(isCatalogAgent("pm")).toBe(true);
    expect(isCatalogAgent("echo")).toBe(false);
  });
});
