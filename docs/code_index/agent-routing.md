# Code Index: Agent Routing

Resolves agent definitions across a layered search chain (target repo → private overlay → public fallback) and composes the system prompt that's injected via `--append-system-prompt`. Per-agent context profiles (frontmatter flags) control how much preamble the agent receives on its first turn.

## Code Index

### src/agents

| Symbol | File | Purpose |
|---|---|---|
| `AgentRouter(repos, fallbackAgentsDir, orgAgentsDir?)` | `router.ts` | Constructor. `orgAgentsDir` is the optional private-overlay mount (e.g. `.claude/agents-org/`); when omitted, only public layers are searched. |
| `AgentRouter.resolveAgent(session)` | `router.ts` | Searches target repo → org overlay → public fallback. First match wins. Returns `AgentDefinition \| null`. |
| `AgentRouter.composeSystemPrompt(session)` | `router.ts` | Builds the full system prompt = common preamble + agent body. Common preamble is `(target_repo_common OR public_common)` plus the org overlay's common (additive, always appended when overlay is configured). Returns common-only if no agent resolves; returns null if both are empty. |
| `loadAgentDefinition(filePath)` | `loader.ts` | Reads a `.md` file, parses frontmatter (flat `key: value` plus dot-notation `context.<flag>: bool`), returns `AgentDefinition`. Returns `null` if file doesn't exist. |
| `DEFAULT_CONTEXT_PROFILE` | `loader.ts` | All five flags (`identity`, `slack`, `workspace`, `threadHistory`, `agentState`) set to `true`. Used when an agent declares no `context.*` overrides. |

### Types

| Type | File | Shape |
|---|---|---|
| `AgentContextProfile` | `loader.ts` | `{ identity, slack, workspace, threadHistory, agentState: boolean }` |
| `AgentDefinition` | `loader.ts` | `{ name, description, tools, model, prompt, context: AgentContextProfile }` |

## Resolution flow

```
runClaudeWithAgent(session)
  │
  ├── agentRouter.resolveAgent(session)
  │     │  (search order, first match wins)
  │     ├── <repo.path>/.claude/agents/<agentType>.md   if session.targetRepo
  │     ├── <orgAgentsDir>/<agentType>.md               if orgAgentsDir configured
  │     └── <fallbackAgentsDir>/<agentType>.md          (junior public)
  │
  ├── buildPromptPreamble(..., contextProfile)
  │     │  (each block emitted only if its flag is true)
  │     ├── <identity>      (persona + bot user ID)
  │     ├── <slack-context> (channel, thread, NO_SLACK_MESSAGE rules)
  │     ├── <workspace>     (target repo, worktree paths, safety rules)
  │     └── <thread-history>
  │
  ├── agentRouter.composeSystemPrompt(session)
  │     │  (common preamble)
  │     ├── repo.path>/.claude/agents/common/*.md   if session.targetRepo has its own
  │     │   OR  <fallbackAgentsDir>/common/*.md     (else)
  │     ├── + <orgAgentsDir>/common/*.md            (always, additive)
  │     └── + agent definition body                 (if resolved)
  │
  └── --append-system-prompt <composed>
```

## Key concepts

### Layered load chain

Agent definitions use **exclusive resolution** (first match wins): target repo overrides org overlay overrides public.

Common preamble files use a **two-tier mix**: target-repo-or-public-fallback is exclusive (one tier or the other, never both), then the org overlay is **additive** on top. So a worker agent targeting a repo with its own `common/` will see *that repo's common* + *the org overlay's common* — but not junior's public `common/`. This asymmetry matters when adding new files to public common: they won't reach agents whose target repo has its own common dir.

### Context profile

Lightweight agents opt out of preamble blocks via flat dot-notation frontmatter:

```yaml
---
name: pr-summarize
context.workspace: false
context.threadHistory: false
---
```

Missing flags default to `true` (safe-but-heavy). Invalid values (anything other than the literal `"true"`/`"false"`) fall back to default — silent typo protection. The skipped blocks are not just elided from the prompt; the underlying fetches (persona load, Slack history fetch) are also skipped, so opting out saves API calls and latency.

### Target repo vs junior

Agent definitions for org-specific work belong in the target repo's `.claude/agents/`. Pure junior agents (lead, default-utility-tasks) live in junior's `.claude/agents/`. Org-specific agents that don't belong in a single product repo live in the org overlay (`.claude/agents-org/`).

## Dependencies

- **Uses**: filesystem (reads `.md` files), `config.repos` (target-repo paths), `Bun.Glob` (common-dir scanning).
- **Used by**: `SessionManager.runClaudeWithAgent` (resolves agent definition early, threads context profile through to preamble building, composes system prompt, sets `session.systemPrompt`).
