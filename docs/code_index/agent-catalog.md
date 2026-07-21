# Code Index: Agent Catalog and Verification

The agent catalog is the provider-neutral source of truth for which agent
roles may be selected, what they are allowed to do, and which handoffs are
valid. Markdown definitions provide prompts; the catalog adds capabilities,
policy, and verification metadata.

## Sources

| Symbol | File | Purpose |
|---|---|---|
| `AGENT_CATALOG` | `src/agents/manifest.ts` | Declares role metadata, capabilities, and handoff policy. |
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
- Private overlay roles are dispatchable only after their identity metadata is
  loaded from `agents-org`.

The old standalone `thinker` and public `lead.md` definitions are retired.
References in older feature plans describe the former two-phase design; the
current orchestrator performs that reasoning and dispatches implementation to
the catalog roles.

## Safety boundary

Catalog verification must run before dispatch. A role may narrow its declared
permissions but cannot widen the target repository, MCP scope, or handoff
policy supplied by the runtime. Keep changes to role metadata and prompt
content covered by `src/agents/*.test.ts` and the provider-parity tests.
