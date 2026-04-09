# Code Index: Agent Routing

## Files

| File | Purpose |
|---|---|
| `src/agents/router.ts` | Loads agent definitions from target repos, composes system prompts |
| `src/agents/loader.ts` | Parses agent markdown files with YAML frontmatter |

## Key Exports

### `src/agents/router.ts`
- `AgentRouter` class:
  - `constructor(repos: RepoConfig[], agentDir: string)` — `agentDir` is relative path within repos (e.g., `.claude/agents`)
  - `getSystemPrompt(agentType, targetRepo?): Promise<string | null>` — loads agent definition, merges with common preamble
  - `getAvailableAgents(targetRepo?): Promise<string[]>` — lists agent markdown files in the repo's agent directory

### `src/agents/loader.ts`
- `loadAgentDefinition(filePath): Promise<AgentDefinition | null>` — reads `.md` file, parses YAML frontmatter
- `AgentDefinition` — `{ name, description, tools?, model?, prompt }`

## Agent Resolution

```
!build message
  │
  ├── AgentRouter.getSystemPrompt("build", "example-backend")
  │     │
  │     ├── Look for: /path/to/example-backend/.claude/agents/build.md
  │     ├── Look for: /path/to/example-backend/.claude/agents/common/building-philosophy.md
  │     │
  │     ├── If found: loadAgentDefinition() → parse frontmatter + body
  │     ├── Merge: common preamble + agent prompt
  │     └── Return composed system prompt
  │
  └── SessionManager sets session.systemPrompt
        └── buildClaudeArgs() adds --append-system-prompt
```

## Agent Definition Format

```markdown
---
name: build
description: Backend builder agent
tools: ["Read", "Edit", "Write", "Bash", "Grep", "Glob"]
model: sonnet
---

You are a backend builder. Build features, fix bugs, refactor code.
...
```

Agent definitions live in **target repos** (not junior). Junior's own `.claude/agents/` are for its own development, not for spawned Claude instances.
