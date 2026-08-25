import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { basename, resolve } from "node:path";
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

/**
 * MCP-only runs deny every tool by default and exact-grant declarations. Keep
 * the compiler's safe-tool allowlist equally explicit so a trusted-definition
 * typo cannot turn a bounded utility into an uncontrolled production writer.
 */
const MCP_ONLY_SAFE_TOOLS = new Set([
  "mcp__slack-bot__slack_read_thread",
  "mcp__slack-bot__slack_read_channel",
  "mcp__slack-bot__slack_search",
  "mcp__slack-bot__slack_search_users",
  "mcp__slack-bot__memory_recall",
  // Bounded telemetry mutation: records an agent's explicit usefulness judgment.
  "mcp__slack-bot__memory_feedback",
  "mcp__slack-bot__runbook_search",
  "mcp__slack-bot__runbook_select",
]);

const MCP_ONLY_CAPABILITY_TOOLS: Partial<
  Record<AgentCapability, readonly string[]>
> = {
  "mongodb-read": [
    "mcp__mongodb__aggregate",
    "mcp__mongodb__count",
    "mcp__mongodb__find",
    "mcp__mongodb__list-databases",
    "mcp__mongodb__list-collections",
    "mcp__mongodb__collection-schema",
  ],
  "pipeline-artifact-write": [
    "mcp__slack-bot__pipeline_get_state",
    "mcp__slack-bot__pipeline_write_artifact",
    "mcp__slack-bot__pipeline_report_outcome",
  ],
  "pipeline-run-start": ["mcp__slack-bot__pipeline_start_run"],
  "github-review-read": ["mcp__slack-bot__github_read_pr_review_state"],
  "github-review-comment": ["mcp__slack-bot__github_post_review"],
  dispatch: [
    "mcp__slack-bot__agent_dispatch",
    "mcp__slack-bot__skill_dispatch",
  ],
};

interface CatalogEntry {
  manifest: AgentManifest;
  tools: readonly string[];
  sourcePath: string;
}

export interface TrustedCatalogOptions {
  publicAgentsDir: string;
  orgAgentsDir: string;
}

/**
 * A trusted definition is active only when its exact bytes are present on the
 * repository's default branch. This deliberately treats dirty, untracked, and
 * feature-branch-only files as unpublished: prompt content can be developed
 * locally, but it cannot grant runtime authority before review and merge.
 */
export interface AgentDefinitionProvenance {
  status: "published" | "unpublished";
  defaultBranchRef: string | null;
  reason: string | null;
}

function gitOutput(cwd: string, args: string[]): Buffer | null {
  try {
    return execFileSync("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function gitText(cwd: string, args: string[]): string | null {
  const output = gitOutput(cwd, args);
  return output === null ? null : output.toString("utf8").trim();
}

function defaultBranchRef(repoRoot: string): string | null {
  const candidates = [
    gitText(repoRoot, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]),
    "origin/main",
    "origin/master",
    // Source checkouts and isolated test repositories may not have a remote.
    // These are still stable branch refs, unlike the current HEAD.
    "main",
    "master",
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (gitText(repoRoot, ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`])) {
      return candidate;
    }
  }
  return null;
}

/**
 * Inspect a definition without activating it. Consumers can expose this state
 * in diagnostics; the catalog compiler below fails closed on unpublished
 * authority-bearing files.
 */
export function inspectAgentDefinitionProvenance(
  sourcePath: string,
): AgentDefinitionProvenance {
  // Never canonicalize the definition path: `realpath` would turn an
  // untracked `rogue.md -> tracked-payload.txt` symlink into the tracked
  // payload's path. Authority belongs to the configured .md path itself.
  let sourceStat: ReturnType<typeof lstatSync>;
  try {
    sourceStat = lstatSync(sourcePath);
  } catch {
    return {
      status: "unpublished",
      defaultBranchRef: null,
      reason: "definition does not exist",
    };
  }
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    return {
      status: "unpublished",
      defaultBranchRef: null,
      reason: "definition is not a regular file",
    };
  }

  const repoRoot = gitText(resolve(sourcePath, ".."), [
    "rev-parse",
    "--show-toplevel",
  ]);
  if (!repoRoot) {
    return {
      status: "unpublished",
      defaultBranchRef: null,
      reason: "definition is not inside a Git checkout",
    };
  }
  // Git canonicalizes the checkout root on macOS (`/private/var`), but not the
  // configured definition path; path identity stays anchored to the .md name.
  const canonicalRepoRoot = realpathSync(repoRoot);
  const ref = defaultBranchRef(canonicalRepoRoot);
  if (!ref) {
    return {
      status: "unpublished",
      defaultBranchRef: null,
      reason: "default branch ref is unavailable",
    };
  }

  const prefix = gitText(resolve(sourcePath, ".."), [
    "rev-parse",
    "--show-prefix",
  ]);
  const repoRelativePath = `${prefix ?? ""}${basename(sourcePath)}`;
  const trackedPath = gitText(canonicalRepoRoot, [
    "ls-files",
    "--error-unmatch",
    "--full-name",
    "--",
    repoRelativePath,
  ]);
  if (trackedPath !== repoRelativePath) {
    return {
      status: "unpublished",
      defaultBranchRef: ref,
      reason: "definition path is not tracked",
    };
  }
  const published = gitOutput(canonicalRepoRoot, ["show", `${ref}:${repoRelativePath}`]);
  if (published === null) {
    return {
      status: "unpublished",
      defaultBranchRef: ref,
      reason: `definition does not exist on ${ref}`,
    };
  }
  if (!published.equals(readFileSync(sourcePath))) {
    return {
      status: "unpublished",
      defaultBranchRef: ref,
      reason: `definition bytes differ from ${ref}`,
    };
  }
  return { status: "published", defaultBranchRef: ref, reason: null };
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

  const provenance = inspectAgentDefinitionProvenance(sourcePath);
  if (provenance.status === "unpublished") {
    console.warn(
      `[agents] unpublished trusted definition ignored: ${sourcePath} (${provenance.reason})`,
    );
    return [];
  }

  const name = required(frontmatter, "name", sourcePath);
  const declaredCapabilities = parseFrontmatterCsv(
    required(frontmatter, "operational.capabilities", sourcePath),
  ).map((capability) => {
    if (!CAPABILITIES.has(capability as AgentCapability)) {
      throw new Error(`${sourcePath}: unknown capability '${capability}'`);
    }
    return capability as AgentCapability;
  });
  // Local verification is baseline runtime access for every trusted agent.
  // Mutation authority still comes from permission intent, mutation policy,
  // sandbox compilation, and managed cwd checks.
  const capabilities = [
    ...new Set<AgentCapability>([
      ...declaredCapabilities,
      "worktree-verify",
    ]),
  ];
  const permissionIntent = enumValue(
    frontmatter,
    "permissions.intent",
    PERMISSION_INTENTS,
    sourcePath,
  );
  const tools = parseFrontmatterCsv(frontmatter.tools);
  if (permissionIntent === "mcp-only") {
    const capabilityTools = new Set(
      capabilities.flatMap(
        (capability) => MCP_ONLY_CAPABILITY_TOOLS[capability] ?? [],
      ),
    );
    const unsafeTool = tools.find(
      (tool) =>
        !MCP_ONLY_SAFE_TOOLS.has(tool) && !capabilityTools.has(tool),
    );
    if (unsafeTool) {
      throw new Error(
        `${sourcePath}: mcp-only agent '${name}' cannot safely request '${unsafeTool}'`,
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
  // Git creates an empty directory for an uninitialized submodule. That is an
  // absent optional overlay, not a mounted-but-incomplete one.
  const orgDirectoryPresent = existsSync(options.orgAgentsDir) &&
    readdirSync(options.orgAgentsDir).length > 0;
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
