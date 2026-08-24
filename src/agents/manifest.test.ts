import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectAgentDefinitionProvenance,
  loadTrustedAgentCatalog,
} from "./manifest.ts";

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
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "tests@junior.local"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Junior tests"], { cwd: root });
  roots.push(root);
  return { root, publicDir, orgDir };
}

function publish(root: string): void {
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-qm", "publish definitions"], { cwd: root });
}

function loadPublishedCatalog(input: ReturnType<typeof fixture>) {
  publish(input.root);
  return loadTrustedAgentCatalog({
    publicAgentsDir: input.publicDir,
    orgAgentsDir: input.orgDir,
  });
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
    const { root, publicDir, orgDir } = fixture();
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

    const catalog = loadPublishedCatalog({ root, publicDir, orgDir });

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
    const { root, publicDir, orgDir } = fixture();
    writeFileSync(
      join(publicDir, "default.md"),
      definition({ name: "default" }).replace(
        /^operational\.mutationPolicy:.*\n/m,
        "",
      ),
    );

    expect(() =>
      loadPublishedCatalog({ root, publicDir, orgDir }),
    ).toThrow("missing required 'operational.mutationPolicy'");
  });

  it("rejects shell or filesystem tools for mcp-only agents", () => {
    const { root, publicDir, orgDir } = fixture();
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
      loadPublishedCatalog({ root, publicDir, orgDir }),
    ).toThrow("mcp-only agent 'unsafe' cannot safely request 'Read'");
  });

  it("rejects mutating MCP tools for mcp-only agents", () => {
    const { root, publicDir, orgDir } = fixture();
    writeFileSync(
      join(publicDir, "default.md"),
      definition({ name: "default", delegates: "unsafe, human" }),
    );
    writeFileSync(
      join(orgDir, "unsafe.md"),
      definition({
        name: "unsafe",
        intent: "mcp-only",
        capabilities: "mongodb-read",
        tools: "mcp__mongodb__update-one",
      }),
    );

    expect(() =>
      loadPublishedCatalog({ root, publicDir, orgDir }),
    ).toThrow(
      "mcp-only agent 'unsafe' cannot safely request 'mcp__mongodb__update-one'",
    );
  });

  it("requires an MCP-only tool's granting capability", () => {
    const { root, publicDir, orgDir } = fixture();
    writeFileSync(
      join(publicDir, "default.md"),
      definition({ name: "default", delegates: "unsafe, human" }),
    );
    writeFileSync(
      join(orgDir, "unsafe.md"),
      definition({
        name: "unsafe",
        intent: "mcp-only",
        capabilities: "pipeline-artifact-write",
        tools: "mcp__mongodb__find",
      }),
    );

    expect(() =>
      loadPublishedCatalog({ root, publicDir, orgDir }),
    ).toThrow(
      "mcp-only agent 'unsafe' cannot safely request 'mcp__mongodb__find'",
    );
  });

  it("rejects unresolved handoffs when the private overlay is mounted", () => {
    const { root, publicDir, orgDir } = fixture();
    writeFileSync(join(orgDir, "README.md"), "# Mounted private overlay\n");
    writeFileSync(
      join(publicDir, "default.md"),
      definition({ name: "default", delegates: "missing-worker, human" }),
    );

    expect(() =>
      loadPublishedCatalog({ root, publicDir, orgDir }),
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
      loadPublishedCatalog({ root, publicDir, orgDir: missingOrgDir }).map((entry) => entry.name),
    ).toEqual(["default"]);
  });

  it("treats an empty uninitialized submodule directory as optional", () => {
    const { root, publicDir, orgDir } = fixture();
    writeFileSync(
      join(publicDir, "default.md"),
      definition({ name: "default", delegates: "private-worker, human" }),
    );

    expect(
      loadPublishedCatalog({ root, publicDir, orgDir }).map((entry) => entry.name),
    ).toEqual(["default"]);
  });

  it("fails closed when a published authority-bearing definition is dirty", () => {
    const { root, publicDir, orgDir } = fixture();
    const defaultPath = join(publicDir, "default.md");
    writeFileSync(defaultPath, definition({ name: "default" }));
    publish(root);
    writeFileSync(defaultPath, `${definition({ name: "default" })}\nLocal authority edit\n`);

    expect(
      inspectAgentDefinitionProvenance(defaultPath),
    ).toMatchObject({
      status: "unpublished",
      defaultBranchRef: "main",
      reason: "definition bytes differ from main",
    });
    expect(() =>
      loadTrustedAgentCatalog({
        publicAgentsDir: publicDir,
        orgAgentsDir: orgDir,
      }),
    ).toThrow("Trusted agent catalog must define the default orchestrator");
  });

  it("ignores untracked authority-bearing definitions", () => {
    const { root, publicDir, orgDir } = fixture();
    writeFileSync(join(publicDir, "default.md"), definition({ name: "default" }));
    publish(root);
    const roguePath = join(publicDir, "rogue.md");
    writeFileSync(roguePath, definition({ name: "rogue" }));

    expect(
      inspectAgentDefinitionProvenance(roguePath),
    ).toMatchObject({
      status: "unpublished",
      reason: "definition path is not tracked",
    });
    expect(
      loadTrustedAgentCatalog({
        publicAgentsDir: publicDir,
        orgAgentsDir: orgDir,
      }).map((entry) => entry.name),
    ).toEqual(["default"]);
  });

  it("rejects an untracked definition symlink to a tracked payload", () => {
    const { root, publicDir, orgDir } = fixture();
    writeFileSync(join(publicDir, "default.md"), definition({ name: "default" }));
    writeFileSync(join(publicDir, "payload.txt"), definition({ name: "rogue" }));
    publish(root);
    const roguePath = join(publicDir, "rogue.md");
    symlinkSync("payload.txt", roguePath);

    expect(inspectAgentDefinitionProvenance(roguePath)).toMatchObject({
      status: "unpublished",
      reason: "definition is not a regular file",
    });
    expect(
      loadTrustedAgentCatalog({
        publicAgentsDir: publicDir,
        orgAgentsDir: orgDir,
      }).map((entry) => entry.name),
    ).toEqual(["default"]);
  });

  it("ignores definitions committed only on the current feature branch", () => {
    const { root, publicDir, orgDir } = fixture();
    writeFileSync(join(publicDir, "default.md"), definition({ name: "default" }));
    publish(root);
    execFileSync("git", ["checkout", "-qb", "feature/branch-only-agent"], {
      cwd: root,
    });
    const branchOnlyPath = join(publicDir, "branch-only.md");
    writeFileSync(branchOnlyPath, definition({ name: "branch-only" }));
    publish(root);

    expect(
      inspectAgentDefinitionProvenance(branchOnlyPath),
    ).toMatchObject({
      status: "unpublished",
      reason: "definition does not exist on main",
    });
    expect(
      loadTrustedAgentCatalog({
        publicAgentsDir: publicDir,
        orgAgentsDir: orgDir,
      }).map((entry) => entry.name),
    ).toEqual(["default"]);
  });
});
