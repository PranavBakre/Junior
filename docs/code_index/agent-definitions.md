# Code Index: Agent Definitions

This module handles loading, parsing, and routing of agent definitions from markdown files with YAML frontmatter.

## Definition Locations

| Path | Purpose |
|---|---|
| `.claude/agents/` | Public fallback agents and shared common prompt files. |
| `agents-org/` | Private overlay agents and common prompt files, mounted as a git submodule. |
| `<target-repo>/.claude/agents/` | Repo-local agent definitions, used first when `session.targetRepo` is set. |
| `support/agents/` | Stateless OpenCode support subagents such as `nr-research`, `sentry-fetch`, and `vercel-status`. |

## Code Index

| Symbol | File | Purpose |
|---|---|---|
| `loadAgentDefinition(filePath)` | `src/agents/loader.ts` | Reads an agent markdown file, parses flat frontmatter, strips quotes, and returns the body prompt. |
| `parseAgentFrontmatter(...)` | `src/agents/loader.ts` | Parses `name`, `description`, `tools`, `model`, `common`, `username`, `iconEmoji`, and `context.*` flags. |
| `AgentRouter.resolveAgent(session)` | `src/agents/router.ts` | Resolves target repo -> org overlay -> public fallback, first match wins. |
| `AgentRouter.composeSystemPrompt(session)` | `src/agents/router.ts` | Prepends selected common prompt files and appends the resolved agent body. |
| `loadOverlayIdentities(...)` | `src/support/agents.ts` | Loads Slack identity frontmatter for overlay/private persistent agents. |
| `loadOpenCodeSupportSubagents()` | `src/opencode/support-agents.ts` | Loads stateless support prompts into generated OpenCode config. |

## Data Flow

1. `AgentDispatcher` (`src/support/router.ts`) identifies a persistent-agent directive when one is present.
2. `SessionManager` sets the active agent and asks `AgentRouter` for the composed prompt.
3. `AgentRouter` resolves the agent from the target repo, private overlay, or public fallback.
4. Common prompt files selected by `common:` are loaded from the repo/public layer, with org overlay common files appended when configured.
5. The composed prompt and Slack identity are passed to the selected runner provider.
