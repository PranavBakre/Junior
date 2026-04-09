# Code Index: Agent Routing

Loads agent definitions from target repos and composes system prompts for spawned Claude processes.

## Code Index

### src/agents

| Function | File | Purpose |
|----------|------|---------|
| `AgentRouter(repos, agentDir)` | `router.ts` | Constructor: `agentDir` is relative path within repos (e.g., `.claude/agents`) |
| `AgentRouter.getSystemPrompt(agentType, targetRepo?)` | `router.ts` | Loads agent definition, merges with common preamble, returns composed prompt |
| `AgentRouter.getAvailableAgents(targetRepo?)` | `router.ts` | Lists agent `.md` files in the repo's agent directory |
| `loadAgentDefinition(filePath)` | `loader.ts` | Reads `.md` file, parses YAML frontmatter, returns definition |

### Types

| Type | File | Purpose |
|------|------|---------|
| `AgentDefinition` | `loader.ts` | `{ name, description, tools?, model?, prompt }` |

## Agent Resolution

```
!build fix auth
  │
  ├── AgentRouter.getSystemPrompt("build", "example-backend")
  │     ├── Look for: /path/to/example-backend/.claude/agents/build.md
  │     ├── Look for: /path/to/example-backend/.claude/agents/common/building-philosophy.md
  │     ├── loadAgentDefinition() → parse frontmatter + body
  │     ├── Merge: common preamble + agent prompt
  │     └── Return composed system prompt
  │
  └── SessionManager sets session.systemPrompt
        └── buildClaudeArgs() adds --append-system-prompt
```

## Key Concepts

### Agent Definition Format

```markdown
---
name: build
description: Backend builder agent
tools: ["Read", "Edit", "Write", "Bash", "Grep", "Glob"]
model: sonnet
---

You are a backend builder. Build features, fix bugs, refactor code.
```

### Target Repo vs Junior

Agent definitions live in **target repos** (not junior). Spawning Claude with `cwd` set to the target repo makes them available. Only agents about Junior itself belong in `junior/.claude/agents/`.

## Dependencies

- **Uses**: filesystem (reads `.md` files from target repos), `config` (RepoConfig paths)
- **Used by**: `SessionManager` (sets `session.systemPrompt` from agent routing)
