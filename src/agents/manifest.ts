import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseAgentFrontmatter,
  parseFrontmatterCsv,
} from "./frontmatter.ts";

/**
 * Trusted agent catalog compiled from operational frontmatter.
 *
 * The Markdown file is the single declaration for an agent. TypeScript owns
 * the schema, validation, and enforcement only. Operational fields are read
 * exclusively from Junior's `.claude/agents` directory and the `agents-org`
 * overlay; target-repository definitions remain prompt-only and cannot widen
 * runtime authority.
 */

/** Matches `AgentPermissionIntent` in loader.ts — kept local to avoid cycles. */
export type CatalogPermissionIntent =
  | "mcp-only"
  | "read-only"
  | "normal"
  | "human-gated"
  | "utility"
  | "no-tools";

export type AgentLifecycle = "persistent" | "stateless";

export type AgentRole =
  | "orchestrator"
  | "planner"
  | "builder"
  | "reviewer"
  | "reproducer"
  | "utility";

/**
 * Mutation authority for product code / external systems.
 * Independently human-gated operations (merge, release, credentials,
 * production writes, destructive ops, data repair) are never granted here —
 * they require an explicit human gate regardless of role.
 */
export type MutationPolicy =
  | "none"
  | "workspace"
  | "human-gated"
  | "external";

/**
 * Provider-neutral capability tokens. Enforcement is best-effort on Claude
 * (tool lists + plan mode); stronger on Codex/OpenCode sandboxes.
 */
export type AgentCapability =
  | "repo-read"
  | "repo-write"
  | "github-review-read"
  | "github-review-comment"
  | "browser-read"
  | "mongodb-read"
  | "pipeline-artifact-write"
  | "pipeline-run-start"
  | "worktree-verify"
  | "worktree-mutate"
  | "dispatch"
  | "orchestrate";

/** Capabilities that always require a human gate — never granted by catalog. */
export const HUMAN_GATED_CAPABILITIES = [
  "merge",
  "release",
  "credentials",
  "production-write",
  "destructive",
  "data-repair",
] as const;

export type HumanGatedCapability = (typeof HUMAN_GATED_CAPABILITIES)[number];

export interface HandoffPolicy {
  /**
   * Agents this role may hand off to. Includes concrete names plus the
   * symbolic `"orchestrator"` (resolved per run context) and `"human"`.
   */
  mayDelegateTo: readonly string[];
  /** Agents that may hand work back to this role (informational / return path). */
  mayReturnTo: readonly string[];
  /** Max parallel fan-out assignments this role may open. */
  maxParallel: number;
}

export interface AgentManifest {
  name: string;
  /** Alternate names that resolve to this manifest (e.g. `junior` → `default`). */
  aliases?: readonly string[];
  lifecycle: AgentLifecycle;
  role: AgentRole;
  capabilities: readonly AgentCapability[];
  mutationPolicy: MutationPolicy;
  /**
   * Provider-neutral permission intent. Used when frontmatter omits
   * `permissions.intent`, and as the ceiling target-repo definitions cannot
   * widen past.
   */
  permissionIntent: CatalogPermissionIntent;
  handoffPolicy: HandoffPolicy;
  /**
   * Trust source for this entry. Operational metadata is only authoritative
   * when sourced from Junior or agents-org.
   */
  trustSource: "junior" | "agents-org";
}

const LIFECYCLES = new Set<AgentLifecycle>(["persistent", "stateless"]);
const ROLES = new Set<AgentRole>([
  "orchestrator",
  "planner",
  "builder",
  "reviewer",
  "reproducer",
  "utility",
]);
const MUTATION_POLICIES = new Set<MutationPolicy>([
  "none",
  "workspace",
  "human-gated",
  "external",
]);
const PERMISSION_INTENTS = new Set<CatalogPermissionIntent>([
  "mcp-only",
  "read-only",
  "normal",
  "human-gated",
  "utility",
  "no-tools",
]);
const CAPABILITIES = new Set<AgentCapability>([
  "repo-read",
  "repo-write",
  "github-review-read",
  "github-review-comment",
  "browser-read",
  "mongodb-read",
  "pipeline-artifact-write",
  "pipeline-run-start",
  "worktree-verify",
  "worktree-mutate",
  "dispatch",
  "orchestrate",
]);

interface CatalogEntry {
  manifest: AgentManifest;
  tools: readonly string[];
  sourcePath: string;
}

export interface TrustedCatalogOptions {
  publicAgentsDir: string;
  orgAgentsDir: string;
}

function required(
  frontmatter: Record<string, string>,
  key: string,
  sourcePath: string,
): string {
  const value = frontmatter[key]?.trim();
  if (!value) throw new Error(`${sourcePath}: missing required '${key}' frontmatter`);
  return value;
}

function enumValue<T extends string>(
  frontmatter: Record<string, string>,
  key: string,
  allowed: ReadonlySet<T>,
  sourcePath: string,
): T {
  const value = required(frontmatter, key, sourcePath);
  if (!allowed.has(value as T)) {
    throw new Error(`${sourcePath}: invalid '${key}' value '${value}'`);
  }
  return value as T;
}

function nonNegativeInt(
  frontmatter: Record<string, string>,
  key: string,
  sourcePath: string,
): number {
  const raw = required(frontmatter, key, sourcePath);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${sourcePath}: '${key}' must be a non-negative integer`);
  }
  return value;
}

function parseCatalogEntry(
  sourcePath: string,
  trustSource: AgentManifest["trustSource"],
): CatalogEntry[] {
  const content = readFileSync(sourcePath, "utf8");
  const { frontmatter } = parseAgentFrontmatter(content);
  if (frontmatter["operational.enabled"] !== "true") return [];

  const name = required(frontmatter, "name", sourcePath);
  const capabilities = parseFrontmatterCsv(
    required(frontmatter, "operational.capabilities", sourcePath),
  ).map((capability) => {
    if (!CAPABILITIES.has(capability as AgentCapability)) {
      throw new Error(`${sourcePath}: unknown capability '${capability}'`);
    }
    return capability as AgentCapability;
  });
  const permissionIntent = enumValue(
    frontmatter,
    "permissions.intent",
    PERMISSION_INTENTS,
    sourcePath,
  );
  const tools = parseFrontmatterCsv(frontmatter.tools);
  if (permissionIntent === "mcp-only") {
    const unsafeTool = tools.find((tool) => !tool.startsWith("mcp__"));
    if (unsafeTool) {
      throw new Error(
        `${sourcePath}: mcp-only agent '${name}' cannot request '${unsafeTool}'`,
      );
    }
  }
  if (
    capabilities.includes("mongodb-read") &&
    !tools.some((tool) => tool.startsWith("mcp__mongodb__"))
  ) {
    throw new Error(
      `${sourcePath}: agent '${name}' declares mongodb-read without a MongoDB tool`,
    );
  }
  if (
    (capabilities.includes("repo-write") ||
      capabilities.includes("worktree-mutate")) &&
    enumValue(
      frontmatter,
      "operational.mutationPolicy",
      MUTATION_POLICIES,
      sourcePath,
    ) !== "workspace"
  ) {
    throw new Error(
      `${sourcePath}: agent '${name}' has write capabilities without workspace mutation policy`,
    );
  }

  const base: AgentManifest = {
    name,
    aliases: parseFrontmatterCsv(frontmatter["operational.aliases"]),
    lifecycle: enumValue(
      frontmatter,
      "operational.lifecycle",
      LIFECYCLES,
      sourcePath,
    ),
    role: enumValue(frontmatter, "operational.role", ROLES, sourcePath),
    capabilities,
    mutationPolicy: enumValue(
      frontmatter,
      "operational.mutationPolicy",
      MUTATION_POLICIES,
      sourcePath,
    ),
    permissionIntent,
    handoffPolicy: {
      mayDelegateTo: parseFrontmatterCsv(
        frontmatter["operational.mayDelegateTo"],
      ),
      mayReturnTo: parseFrontmatterCsv(frontmatter["operational.mayReturnTo"]),
      maxParallel: nonNegativeInt(
        frontmatter,
        "operational.maxParallel",
        sourcePath,
      ),
    },
    trustSource,
  };

  const entries: CatalogEntry[] = [{ manifest: base, tools, sourcePath }];
  for (const variant of parseFrontmatterCsv(frontmatter["operational.variants"])) {
    entries.push({
      manifest: { ...base, name: variant, aliases: [] },
      tools,
      sourcePath,
    });
  }
  return entries;
}

function readCatalogDirectory(
  dirPath: string,
  trustSource: AgentManifest["trustSource"],
  optional = false,
): CatalogEntry[] {
  let files: string[];
  try {
    files = readdirSync(dirPath)
      .filter((entry) => entry.endsWith(".md"))
      .sort();
  } catch (error) {
    if (optional) return [];
    throw new Error(
      `Cannot load trusted agent definitions from ${dirPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return files.flatMap((file) =>
    parseCatalogEntry(resolve(dirPath, file), trustSource),
  );
}

export function loadTrustedAgentCatalog(
  options: TrustedCatalogOptions,
): readonly AgentManifest[] {
  const orgDirectoryPresent = existsSync(options.orgAgentsDir);
  const entries = [
    ...readCatalogDirectory(options.publicAgentsDir, "junior"),
    ...readCatalogDirectory(options.orgAgentsDir, "agents-org", true),
  ];
  const names = new Map<string, CatalogEntry>();
  const aliases = new Map<string, string>();

  for (const entry of entries) {
    const { manifest, sourcePath } = entry;
    const prior = names.get(manifest.name);
    const aliasOwner = aliases.get(manifest.name);
    if (prior || aliasOwner) {
      throw new Error(
        prior
          ? `Duplicate trusted agent '${manifest.name}' in ${prior.sourcePath} and ${sourcePath}`
          : `${sourcePath}: agent name '${manifest.name}' conflicts with alias owned by '${aliasOwner}'`,
      );
    }
    names.set(manifest.name, entry);
    for (const alias of manifest.aliases ?? []) {
      if (names.has(alias) || aliases.has(alias)) {
        throw new Error(`${sourcePath}: duplicate agent alias '${alias}'`);
      }
      aliases.set(alias, manifest.name);
    }
  }

  if (!names.has("default")) {
    throw new Error("Trusted agent catalog must define the default orchestrator");
  }
  for (const entry of entries) {
    for (const target of [
      ...entry.manifest.handoffPolicy.mayDelegateTo,
      ...entry.manifest.handoffPolicy.mayReturnTo,
    ]) {
      if (
        target !== "human" &&
        target !== "orchestrator" &&
        !names.has(target) &&
        !aliases.has(target)
      ) {
        // The private overlay is optional for public Junior installations.
        // When it is mounted, however, every cross-reference must resolve so
        // an incomplete private definition fails at startup rather than later
        // during dispatch.
        if (!orgDirectoryPresent && entry.manifest.trustSource === "junior") {
          continue;
        }
        throw new Error(
          `${entry.sourcePath}: agent '${entry.manifest.name}' references unknown handoff target '${target}'`,
        );
      }
    }
  }

  return Object.freeze(entries.map((entry) => Object.freeze(entry.manifest)));
}

function resolveTrustedRepositoryRoot(): string {
  // Source execution lives at src/agents; bundled execution lives at dist.
  // Never fall back to process.cwd(): a runner may be launched from a target
  // repository, which must not become an operational metadata trust root.
  const candidates = [
    resolve(import.meta.dir, "../.."),
    resolve(import.meta.dir, ".."),
  ];
  const root = candidates.find((candidate) =>
    existsSync(resolve(candidate, ".claude/agents/default.md")),
  );
  if (!root) {
    throw new Error(
      `Cannot locate Junior's trusted .claude/agents directory from ${import.meta.dir}`,
    );
  }
  return root;
}

const repositoryRoot = resolveTrustedRepositoryRoot();

export const TRUSTED_AGENT_CATALOG = loadTrustedAgentCatalog({
  publicAgentsDir: resolve(repositoryRoot, ".claude/agents"),
  orgAgentsDir: resolve(repositoryRoot, "agents-org"),
});
