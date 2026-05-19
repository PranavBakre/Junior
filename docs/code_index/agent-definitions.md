# Code Index: Agent Definitions

This module handles loading and parsing of agent definitions from markdown files with YAML frontmatter.

## Directory Structure

- [.claude/agents/](file:///Users/psbakre/Projects/junior/.claude/agents/): Public agent definitions.
- [agents-org/](file:///Users/psbakre/Projects/junior/agents-org/): Private/overlay agent definitions (git submodule).
- [support/agents/](file:///Users/psbakre/Projects/junior/support/agents/): Stateless support sub-agent prompts.

## Key Files

- [loader.ts](file:///Users/psbakre/Projects/junior/src/agents/loader.ts): Handles reading `.md` files and parsing frontmatter identities.
- [router.ts](file:///Users/psbakre/Projects/junior/src/agents/router.ts): High-level routing logic to pick an agent definition based on thread state.

## Data Flow

1. `AgentDispatcher` (in `support/router.ts`) identifies the requested agent.
2. `AgentRouter` calls the `loader` to fetch the definition from the target repo's `.claude/agents/` or Junior's own registries.
3. The frontmatter (username, emoji) is used for Slack attribution.
4. The markdown body is passed as the system prompt to the runner provider.
