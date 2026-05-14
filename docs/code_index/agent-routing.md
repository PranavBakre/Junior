# Code Index: Agent Routing

Resolves agent definitions across a layered search chain (target repo → private overlay → public fallback) and composes the system prompt that's injected via `--append-system-prompt`. Per-agent context profiles (frontmatter flags) control how much preamble the agent receives on its first turn.

## Code Index

### src/agents

| Symbol | File | Purpose |
|---|---|---|
| `AgentRouter(repos, fallbackAgentsDir, orgAgentsDir?)` | `router.ts` | Constructor. `orgAgentsDir` is the optional private-overlay mount (e.g. `.claude/agents-org/`); omit for public-only. |
| `AgentRouter.resolveAgent(session)` | `router.ts` | Searches target repo → org overlay → public fallback. First match wins. Returns `AgentDefinition \| null`. |
| `AgentRouter.composeSystemPrompt(session)` | `router.ts` | Builds the system prompt = common preamble + agent body. Common is `(target_repo_common OR public_common)` plus the org overlay's common (always additive). |
| `loadAgentDefinition(filePath)` | `loader.ts` | Reads a `.md` file, parses frontmatter (flat `key: value`, dot-notation `context.<flag>`, quoted-value strip). Returns `null` if missing. |
| `DEFAULT_CONTEXT_PROFILE` | `loader.ts` | All five flags (`identity`, `slack`, `workspace`, `threadHistory`, `agentState`) set to `true`. |

### Types

| Type | File | Shape |
|---|---|---|
| `AgentContextProfile` | `loader.ts` | `{ identity, slack, workspace, threadHistory, agentState: boolean }` |
| `AgentDefinition` | `loader.ts` | `{ name, description, tools, model, prompt, context, username, iconEmoji }` |

## Resolution flow

```
runClaudeWithAgent(session)
  │
  ├── agentRouter.resolveAgent(session)
  │     │  (first match wins)
  │     ├── <repo.path>/.claude/agents/<agentType>.md   if session.targetRepo
  │     ├── <orgAgentsDir>/<agentType>.md               if orgAgentsDir configured
  │     └── <fallbackAgentsDir>/<agentType>.md          (junior public)
  │
  ├── buildPromptPreamble(..., contextProfile)
  │     │  (each block emitted only if its flag is true)
  │     ├── <identity>      (persona + bot user ID)
  │     ├── <slack-context> (channel, thread, NO_SLACK_MESSAGE rule, no-double-post rule)
  │     ├── <workspace>     (target repo, worktree paths, safety rules — single- or multi-repo)
  │     └── <thread-context>
  │
  ├── agentRouter.composeSystemPrompt(session)
  │     ├── repo.path/.claude/agents/common/*.md   if target-repo has its own
  │     │   OR  <fallbackAgentsDir>/common/*.md     (else)
  │     ├── + <orgAgentsDir>/common/*.md            (always additive)
  │     └── + agent definition body                 (if resolved)
  │
  └── --append-system-prompt <composed + agent-identity-block + dispatch-allow-block>
```

## Key Concepts

### Layered load chain

Agent definitions use **exclusive resolution** (first match wins). Common preamble files use a **two-tier mix**: target-repo-or-public-fallback (exclusive), then org overlay (additive). Adding files to public `common/` won't reach agents whose target repo has its own common dir.

### Context profile

Lightweight agents opt out of preamble blocks via flat dot-notation frontmatter:

```yaml
---
name: pr-summarize
context.workspace: false
context.threadHistory: false
---
```

Missing flags default to `true`. Invalid values fall back to default (silent typo protection). Skipping a block also skips the underlying fetch (persona load, Slack history, etc.) — saves tokens and latency.

### Agent identity in frontmatter

`username:` + `iconEmoji:` declare the slack identity of overlay/private agents. Loaded by `loadOverlayIdentities` (see `persistent-agents.md`). Both fields required; partial declarations are ignored.

## Dependencies

- **Uses**: filesystem (`Bun.file` + `Bun.Glob`), `config.repos`, `session/types`
- **Used by**: `SessionManager.runClaudeWithAgent` (resolves definition, threads context profile through preamble building, composes system prompt)
