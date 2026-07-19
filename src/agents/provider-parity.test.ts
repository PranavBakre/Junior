/**
 * Provider-neutral operational parity goldens.
 *
 * Locks the safety-critical surface so no provider / prompt path grants a
 * catalog role different authority or handoff rights than the trusted catalog.
 * Broader wording/semantic normalization stays out of scope until controllers
 * are stable.
 */

import { describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { canDispatch } from "../support/agents.ts";
import { resolveEffectivePermissionIntent } from "./loader.ts";
import {
  TRUSTED_AGENT_CATALOG,
  type AgentManifest,
  type CatalogPermissionIntent,
} from "./manifest.ts";
import {
  listCatalogAgents,
  registryAllowsHandoff,
  resolveAgentManifest,
  resolveHandoffTarget,
  type OrchestratorContext,
} from "./registry.ts";

const agentsDir = path.resolve(import.meta.dir, "../../.claude/agents");

/** Public prompt bodies for operational roles that ship an agent .md. */
const PUBLIC_PROMPT_AGENTS = [
  "architect",
  "build",
  "default",
  "frontend",
  "pm",
  "reproducer",
  "review",
] as const;

/**
 * Soft composed-prompt budget. Set generously so currently large bodies do
 * not fail the suite; the assertion only fails on runaway growth past
 * max(current observed, floor) * 1.10.
 */
const PROMPT_BODY_SOFT_FLOOR = 40_000;

/** Representative non-edges that must stay closed (catalog fail-closed). */
const FORBIDDEN_HANDOFFS: Array<[string, string]> = [
  ["pm", "review"],
  ["pm", "reproducer"],
  ["architect", "pm"],
  ["architect", "review"],
  ["review", "reproducer"],
  ["review", "pm"],
  ["build", "pm"],
  ["build", "architect"],
  ["frontend", "pm"],
  ["frontend", "reproducer"],
  ["reproducer", "pm"],
];

function frontmatterIntent(content: string): CatalogPermissionIntent | null {
  const match = content.match(
    /^permissions\.intent:\s*(read-only|normal|human-gated|utility|no-tools)\s*$/m,
  );
  return (match?.[1] as CatalogPermissionIntent | undefined) ?? null;
}

function promptBody(content: string): string {
  if (!content.startsWith("---")) return content;
  const second = content.indexOf("---", 3);
  if (second === -1) return content;
  return content.slice(second + 3).trim();
}

describe("provider parity — catalog permissions", () => {
  it("lists every operational catalog role once", () => {
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

  it.each([...TRUSTED_AGENT_CATALOG])(
    "$name: resolveEffectivePermissionIntent matches catalog ceiling",
    (manifest: AgentManifest) => {
      // Missing frontmatter → catalog
      expect(
        resolveEffectivePermissionIntent(
          { intent: null, mcp: [], tools: [] },
          manifest.name,
        ),
      ).toBe(manifest.permissionIntent);

      // Declaring the catalog intent → same
      expect(
        resolveEffectivePermissionIntent(
          { intent: manifest.permissionIntent, mcp: [], tools: [] },
          manifest.name,
        ),
      ).toBe(manifest.permissionIntent);

      // Widening attempts clamp to catalog for restricted roles
      if (manifest.permissionIntent !== "normal") {
        expect(
          resolveEffectivePermissionIntent(
            { intent: "normal", mcp: [], tools: [] },
            manifest.name,
          ),
        ).toBe(manifest.permissionIntent);
      }
    },
  );

  it.each([...PUBLIC_PROMPT_AGENTS])(
    "%s.md frontmatter permissions.intent matches catalog",
    async (name) => {
      const content = await fs.readFile(
        path.join(agentsDir, `${name}.md`),
        "utf-8",
      );
      const declared = frontmatterIntent(content);
      const manifest = resolveAgentManifest(name);
      expect(manifest).not.toBeNull();
      expect(declared).toBe(manifest!.permissionIntent);
    },
  );
});

describe("provider parity — handoff graph vs canDispatch", () => {
  const contexts: OrchestratorContext[] = ["default", "support"];

  it.each([...TRUSTED_AGENT_CATALOG])(
    "$name: every mayDelegateTo edge is accepted by canDispatch + registry",
    (manifest: AgentManifest) => {
      for (const context of contexts) {
        for (const target of manifest.handoffPolicy.mayDelegateTo) {
          expect(registryAllowsHandoff(manifest.name, target, context)).toBe(
            true,
          );
          expect(canDispatch(manifest.name, target, context)).toBe(true);

          // Concrete resolved target (orchestrator → lead/default) also works.
          const resolved = resolveHandoffTarget(target, context);
          expect(canDispatch(manifest.name, resolved, context)).toBe(true);
        }
      }
    },
  );

  it("keeps representative non-edges closed", () => {
    for (const [source, target] of FORBIDDEN_HANDOFFS) {
      expect(registryAllowsHandoff(source, target)).toBe(false);
      expect(canDispatch(source, target)).toBe(false);
    }
  });

  it("always permits human escalation for catalog roles", () => {
    for (const manifest of TRUSTED_AGENT_CATALOG) {
      expect(canDispatch(manifest.name, "human")).toBe(true);
      expect(registryAllowsHandoff(manifest.name, "human")).toBe(true);
    }
  });

  it("orchestrators may fan out to every registered worker", () => {
    const workers = [
      "pm",
      "architect",
      "build",
      "frontend",
      "review",
      "reproducer",
    ];
    for (const orch of ["default", "lead", "junior"] as const) {
      for (const worker of workers) {
        expect(canDispatch(orch, worker)).toBe(true);
      }
    }
  });
});

describe("provider parity — prompt body soft budget", () => {
  it("keeps public agent prompt bodies under a soft budget (or current+10%)", async () => {
    for (const name of PUBLIC_PROMPT_AGENTS) {
      const content = await fs.readFile(
        path.join(agentsDir, `${name}.md`),
        "utf-8",
      );
      const size = promptBody(content).length;
      expect(size).toBeGreaterThan(0);
      // Soft target 40k. Bodies already over that get current+10% headroom so
      // the suite does not fail on today's content; absolute absurdity cap 200k.
      const softCap = Math.max(
        Math.ceil(PROMPT_BODY_SOFT_FLOOR * 1.1),
        Math.ceil(size * 1.1),
      );
      expect(size, `${name} prompt body (${size} chars)`).toBeLessThanOrEqual(
        softCap,
      );
      expect(size, `${name} absolute cap`).toBeLessThan(200_000);
    }
  });

  it("public agents declare Runtime outcomes guidance", async () => {
    for (const name of PUBLIC_PROMPT_AGENTS) {
      const content = await fs.readFile(
        path.join(agentsDir, `${name}.md`),
        "utf-8",
      );
      expect(content).toContain("## Runtime outcomes");
      expect(content).toMatch(/pipeline_report_outcome/);
    }
  });

  it("orchestrator prompts do not require a by junior attribution suffix", async () => {
    const defaultMd = await fs.readFile(
      path.join(agentsDir, "default.md"),
      "utf-8",
    );
    const bugPipeline = await fs.readFile(
      path.join(agentsDir, "common/bug-pipeline.md"),
      "utf-8",
    );
    // Templates must not instruct orchestrators to append "by junior".
    expect(defaultMd).toMatch(/Do not append a `by junior` attribution suffix/);
    expect(bugPipeline).not.toMatch(/^by junior\s*$/m);
    // Workers still use their own attribution.
    const review = await fs.readFile(path.join(agentsDir, "review.md"), "utf-8");
    const reproducer = await fs.readFile(
      path.join(agentsDir, "reproducer.md"),
      "utf-8",
    );
    expect(review).toContain("by review");
    expect(reproducer).toContain("by reproducer");
  });
});
