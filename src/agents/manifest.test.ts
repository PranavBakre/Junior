import { afterEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTrustedAgentCatalog } from "./manifest.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture(): { root: string; publicDir: string; orgDir: string } {
  const root = mkdtempSync(join(tmpdir(), "junior-agent-catalog-"));
  const publicDir = join(root, "public");
  const orgDir = join(root, "org");
  mkdirSync(publicDir);
  mkdirSync(orgDir);
  roots.push(root);
  return { root, publicDir, orgDir };
}

function definition(options: {
  name: string;
  intent?: string;
  capabilities?: string;
  tools?: string;
  delegates?: string;
  aliases?: string;
  variants?: string;
}): string {
  return `---
name: ${options.name}
tools: ${options.tools ?? "Read"}
permissions.intent: ${options.intent ?? "normal"}
operational.enabled: true
operational.aliases: ${options.aliases ?? ""}
operational.variants: ${options.variants ?? ""}
operational.lifecycle: persistent
operational.role: ${options.name === "default" ? "orchestrator" : "utility"}
operational.capabilities: ${options.capabilities ?? "repo-read"}
operational.mutationPolicy: none
operational.mayDelegateTo: ${options.delegates ?? "human"}
operational.mayReturnTo: orchestrator
operational.maxParallel: 0
---

# ${options.name}
`;
}

describe("trusted operational frontmatter", () => {
  it("compiles public and private definitions with path-derived trust", () => {
    const { publicDir, orgDir } = fixture();
    writeFileSync(
      join(publicDir, "default.md"),
      definition({
        name: "default",
        aliases: "junior",
        variants: "lead",
        delegates: "onboard-member, human",
      }),
    );
    writeFileSync(
      join(orgDir, "onboard-member.md"),
      definition({
        name: "onboard-member",
        intent: "mcp-only",
        capabilities: "mongodb-read",
        tools: "mcp__mongodb__find",
      }),
    );

    const catalog = loadTrustedAgentCatalog({
      publicAgentsDir: publicDir,
      orgAgentsDir: orgDir,
    });

    expect(catalog.map((entry) => entry.name)).toEqual([
      "default",
      "lead",
      "onboard-member",
    ]);
    expect(catalog[0]?.aliases).toEqual(["junior"]);
    expect(catalog[0]?.trustSource).toBe("junior");
    expect(catalog[2]?.trustSource).toBe("agents-org");
  });

  it("fails fast when a trusted operational field is missing", () => {
    const { publicDir, orgDir } = fixture();
    writeFileSync(
      join(publicDir, "default.md"),
      definition({ name: "default" }).replace(
        /^operational\.mutationPolicy:.*\n/m,
        "",
      ),
    );

    expect(() =>
      loadTrustedAgentCatalog({
        publicAgentsDir: publicDir,
        orgAgentsDir: orgDir,
      }),
    ).toThrow("missing required 'operational.mutationPolicy'");
  });

  it("rejects shell or filesystem tools for mcp-only agents", () => {
    const { publicDir, orgDir } = fixture();
    writeFileSync(join(publicDir, "default.md"), definition({ name: "default" }));
    writeFileSync(
      join(orgDir, "unsafe.md"),
      definition({
        name: "unsafe",
        intent: "mcp-only",
        tools: "Read, mcp__mongodb__find",
      }),
    );

    expect(() =>
      loadTrustedAgentCatalog({
        publicAgentsDir: publicDir,
        orgAgentsDir: orgDir,
      }),
    ).toThrow("mcp-only agent 'unsafe' cannot request 'Read'");
  });

  it("rejects unresolved handoffs when the private overlay is mounted", () => {
    const { publicDir, orgDir } = fixture();
    writeFileSync(
      join(publicDir, "default.md"),
      definition({ name: "default", delegates: "missing-worker, human" }),
    );

    expect(() =>
      loadTrustedAgentCatalog({
        publicAgentsDir: publicDir,
        orgAgentsDir: orgDir,
      }),
    ).toThrow("references unknown handoff target 'missing-worker'");
  });

  it("keeps the private overlay optional for public installations", () => {
    const { root, publicDir } = fixture();
    const missingOrgDir = join(root, "not-mounted");
    writeFileSync(
      join(publicDir, "default.md"),
      definition({ name: "default", delegates: "private-worker, human" }),
    );

    expect(
      loadTrustedAgentCatalog({
        publicAgentsDir: publicDir,
        orgAgentsDir: missingOrgDir,
      }).map((entry) => entry.name),
    ).toEqual(["default"]);
  });
});
