# Code Index: Agent Catalog and Verification

The agent catalog is the provider-neutral source of truth for which agent
roles may be selected, what they are allowed to do, and which handoffs are
valid. Trusted Markdown definitions provide both prompts and operational
metadata; TypeScript parses, validates, and enforces that catalog.

## Sources

| Symbol | File | Purpose |
|---|---|---|
| `operational.*` frontmatter | `.claude/agents/*.md`, `agents-org/*.md` | Single source for each trusted role's lifecycle, capabilities, mutation policy, and handoffs. |
| `loadTrustedAgentCatalog()` | `src/agents/manifest.ts` | Compiles trusted frontmatter and fails on invalid metadata, duplicate names, unsafe MCP-only tools, or unresolved handoffs. |
| `AGENT_IDENTITIES` | `src/support/agents.ts` | Public Slack identities and dispatch aliases. Core identities are `default`, `lead`, `reproducer`, `review`, and `echo`; support-channel `lead` sessions resolve to the `default` definition. |
| `loadOverlayIdentities()` | `src/support/agents.ts` | Loads private `agents-org` identities from frontmatter without replacing existing public entries. |
| `AgentRegistry` | `src/agents/registry.ts` | Loads/reloads definitions and resolves dispatchable agents. |
| `AgentRouter` | `src/agents/router.ts` | Chooses a definition and builds the prompt for a turn. |
| `getAgentCapabilities()` | `src/agents/capabilities.ts` | Returns capability metadata for policy checks and prompts. |
| `verifyAgentDefinition()` | `src/agents/verification.ts` | Checks definition frontmatter, required sections, tools, and policy constraints. |
| `loadAgentDefinition()` | `src/agents/loader.ts` | Parses markdown frontmatter and materializes a definition. |

## Current roles

- `default`: the general orchestrator; support-channel `lead` markers resolve
  here and layer the bug-pipeline playbook when appropriate.
- `reproducer`: read-only reproduction and later validation of a local fix.
- `review`: review and merge-readiness checks.
- `pm`, `architect`, `build`, and `frontend`: catalog roles for planning and
  implementation handoffs. They are not interchangeable persistent Slack
  identities.
- Junior owns provider-native implementation fan-out. `build` and `frontend`
  do not receive the `Agent` tool; their assignment starts from Junior's
  file/symbol/SHA evidence capsule and returns scope gaps through the durable
  run contract.
- Runtime policy enforces this across providers: Claude disallows `Agent`,
  OpenCode denies `task` and registers no subagents, and generated Codex config
  disables the `multi_agent` feature.
- Private overlay roles are dispatchable only after their identity metadata is
  loaded from `agents-org`.

The old standalone `thinker` and public `lead.md` definitions are retired.
References in older feature plans describe the former two-phase design; the
current orchestrator performs that reasoning and dispatches implementation to
the catalog roles.

## Safety boundary

Catalog verification runs at startup. Only Junior's public definitions and the
`agents-org` overlay are trusted for operational fields. A target-repository
override may narrow its declared permissions but cannot widen capabilities,
MCP scope, mutation policy, or handoffs. Keep role metadata and prompt changes
covered by `src/agents/*.test.ts` and the provider-parity tests.
