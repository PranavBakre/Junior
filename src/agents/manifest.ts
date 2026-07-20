/**
 * Trusted agent catalog — operational metadata source of truth.
 *
 * Agent definitions contain two classes of data:
 * 1. Trusted operational metadata (this module): lifecycle, capabilities,
 *    mutation policy, handoff graph, and provider permission intent.
 * 2. Prompt content (`.claude/agents/*.md` and overlays): role instructions,
 *    conventions, examples.
 *
 * Only Junior (this catalog) and `agents-org` may define or widen operational
 * metadata. Target repositories may supplement prompt content but must not
 * grant themselves new tools, identities, mutation authority, or handoff edges.
 *
 * Load order for operational fields:
 *   1. This static catalog (Junior) — sole authority for listed roles
 *   2. agents-org may register additional identities / optional agents but
 *      cannot widen capabilities of catalog agents
 *   3. Target-repo `.claude/agents/*.md` — prompt content only; operational
 *      overrides are stripped / clamped by the registry
 *
 * @see docs/features/agent-product-debugging-pipeline-implementation-plan.md Phase 3
 */

/** Matches `AgentPermissionIntent` in loader.ts — kept local to avoid cycles. */
export type CatalogPermissionIntent =
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
  | "reproducer";

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
  | "pipeline-artifact-write"
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

const ORCHESTRATOR_HANDOFF: HandoffPolicy = {
  // Orchestrators may dispatch every registered operational worker + human.
  mayDelegateTo: [
    "pm",
    "architect",
    "build",
    "frontend",
    "review",
    "reproducer",
    "human",
  ],
  mayReturnTo: [],
  maxParallel: 4,
};

const PLANNER_CAPABILITIES: readonly AgentCapability[] = [
  "repo-read",
  "pipeline-artifact-write",
];

const BUILDER_CAPABILITIES: readonly AgentCapability[] = [
  "repo-read",
  "repo-write",
  "worktree-mutate",
  "pipeline-artifact-write",
  "dispatch",
];

/**
 * Static trusted catalog for operational roles.
 * Product roles (pm, architect, build, frontend) are dispatchable internally
 * without a public Slack identity entry in AGENT_IDENTITIES.
 */
export const TRUSTED_AGENT_CATALOG: readonly AgentManifest[] = [
  {
    name: "default",
    aliases: ["junior"],
    lifecycle: "persistent",
    role: "orchestrator",
    capabilities: [
      "repo-read",
      "repo-write",
      "worktree-mutate",
      "pipeline-artifact-write",
      "dispatch",
      "orchestrate",
      "github-review-read",
    ],
    mutationPolicy: "workspace",
    permissionIntent: "normal",
    handoffPolicy: ORCHESTRATOR_HANDOFF,
    trustSource: "junior",
  },
  {
    name: "lead",
    lifecycle: "persistent",
    role: "orchestrator",
    capabilities: [
      "repo-read",
      "repo-write",
      "worktree-mutate",
      "pipeline-artifact-write",
      "dispatch",
      "orchestrate",
      "github-review-read",
    ],
    mutationPolicy: "workspace",
    permissionIntent: "normal",
    handoffPolicy: ORCHESTRATOR_HANDOFF,
    trustSource: "junior",
  },
  {
    name: "pm",
    lifecycle: "persistent",
    role: "planner",
    capabilities: PLANNER_CAPABILITIES,
    // Repository read + pipeline-scoped artifact writes; no product-code push.
    mutationPolicy: "human-gated",
    permissionIntent: "human-gated",
    handoffPolicy: {
      mayDelegateTo: ["architect", "build", "frontend", "orchestrator", "human"],
      mayReturnTo: ["orchestrator"],
      maxParallel: 1,
    },
    trustSource: "junior",
  },
  {
    name: "architect",
    lifecycle: "persistent",
    role: "planner",
    capabilities: PLANNER_CAPABILITIES,
    mutationPolicy: "human-gated",
    permissionIntent: "human-gated",
    handoffPolicy: {
      mayDelegateTo: ["build", "frontend", "orchestrator", "human"],
      mayReturnTo: ["pm", "orchestrator"],
      maxParallel: 2,
    },
    trustSource: "junior",
  },
  {
    name: "build",
    lifecycle: "persistent",
    role: "builder",
    capabilities: BUILDER_CAPABILITIES,
    // Ordinary workspace work inside registered worktrees — not merge/prod.
    mutationPolicy: "workspace",
    permissionIntent: "normal",
    handoffPolicy: {
      // build ↔ frontend; build → review | orchestrator; any → human
      mayDelegateTo: ["frontend", "review", "orchestrator", "human"],
      mayReturnTo: ["frontend", "review", "orchestrator", "pm", "architect"],
      maxParallel: 1,
    },
    trustSource: "junior",
  },
  {
    name: "frontend",
    lifecycle: "persistent",
    role: "builder",
    capabilities: BUILDER_CAPABILITIES,
    mutationPolicy: "workspace",
    permissionIntent: "normal",
    handoffPolicy: {
      mayDelegateTo: ["build", "review", "orchestrator", "human"],
      mayReturnTo: ["build", "review", "orchestrator", "pm", "architect"],
      maxParallel: 1,
    },
    trustSource: "junior",
  },
  {
    name: "review",
    lifecycle: "persistent",
    role: "reviewer",
    capabilities: [
      "repo-read",
      "github-review-read",
      "github-review-comment",
      "pipeline-artifact-write",
    ],
    // No product-code edits or push.
    mutationPolicy: "none",
    permissionIntent: "read-only",
    handoffPolicy: {
      mayDelegateTo: ["build", "frontend", "orchestrator", "human"],
      mayReturnTo: ["build", "frontend", "orchestrator"],
      maxParallel: 1,
    },
    trustSource: "junior",
  },
  {
    name: "reproducer",
    lifecycle: "persistent",
    role: "reproducer",
    capabilities: [
      "repo-read",
      "browser-read",
      "pipeline-artifact-write",
    ],
    // Browser/read-only product access + pipeline artifacts; no product-code edits.
    mutationPolicy: "none",
    permissionIntent: "read-only",
    handoffPolicy: {
      mayDelegateTo: ["build", "frontend", "review", "orchestrator", "human"],
      mayReturnTo: ["orchestrator"],
      maxParallel: 1,
    },
    trustSource: "junior",
  },
] as const;
