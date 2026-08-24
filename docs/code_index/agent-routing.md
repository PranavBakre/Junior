# Code Index: Agent Routing

Resolves agent definitions across a layered search chain (target repo → private overlay → public fallback) and composes the system prompt. Per-agent `common:` profiles select canonical shared skills, and context profiles control how much Slack/thread preamble the agent receives on its first turn.

## Code Index

### src/agents

| Symbol | File | Purpose |
|---|---|---|
| `AgentRouter(repos, fallbackAgentsDir, orgAgentsDir?)` | `router.ts` | Constructor. `orgAgentsDir` is the optional private-overlay mount (e.g. `agents-org/`); omit for public-only. |
| `AgentRouter.resolveAgent(session)` | `router.ts` | Searches target repo → org overlay → public fallback. First match wins. Returns `AgentDefinition \| null`. |
| `AgentRouter.composeSystemPrompt(session)` | `router.ts` | Builds the system prompt = selected shared playbooks + agent body. Each `common:` name resolves target-repo common first, then the canonical `support/skills/<name>/SKILL.md`; matching org common overlays append additively. |
| `loadAgentDefinition(filePath)` | `loader.ts` | Reads a `.md` file, parses frontmatter (flat `key: value`, dot-notation `context.<flag>`, quoted-value strip). Returns `null` if missing. |
| `inspectAgentDefinitionProvenance(path)` | `manifest.ts` | Compares an authority-bearing definition's on-disk bytes to its own default-branch Git blob. Reports `published` or `unpublished`; the catalog ignores unpublished entries. |
| `DEFAULT_CONTEXT_PROFILE` | `loader.ts` | All five flags (`identity`, `slack`, `workspace`, `threadHistory`, `agentState`) set to `true`. |

### Types

| Type | File | Shape |
|---|---|---|
| `AgentContextProfile` | `loader.ts` | `{ identity, slack, workspace, threadHistory, agentState: boolean }` |
| `AgentDefinition` | `loader.ts` | `{ name, description, tools, model, modelClaude, common, prompt, context (including threadHistoryLimit), permissions, username, iconEmoji, imageUrl }` |

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
  │     ├── selected common files from repo common, falling back per file to canonical support skills
  │     ├── + matching selected common files from org common
  │     └── + agent definition body                 (if resolved)
  │
  └── --append-system-prompt <composed + agent-identity-block + dispatch-allow-block>
```

## Key Concepts

### Layered load chain

Agent definitions use **exclusive resolution** (first match wins). Shared playbooks are selected by each agent's `common:` frontmatter profile. Each selected name is loaded from target-repo common when present, otherwise canonical `support/skills/<name>/SKILL.md`; matching org overlay common files append additively. Adding a skill does nothing until an agent profile names it.

The operational catalog has a separate publication gate: a Junior or
`agents-org` definition with `operational.enabled: true` is compiled only when
its bytes exactly match the definition at that repository's default remote
branch (or local `main`/`master` when no remote ref exists). Dirty files,
untracked files, and commits visible only from a feature branch are reported as
unpublished and ignored. The configured definition must be a tracked regular
file, never a symlink to some other tracked payload. A missing published `default` role is a startup error,
so local authority changes cannot silently take effect.

### Common profile

```yaml
---
name: build
common: core,building-philosophy
---
```

`core` is the small always-on contract. Other shared files are opt-in by profile so long reference material does not reach every agent by default.

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

`username:` + `iconEmoji:` or `imageUrl:` declare the slack identity of overlay/private agents. Loaded by `loadOverlayIdentities` (see `persistent-agents.md`). Username plus one visual field is required; partial declarations are ignored.

## Dependencies

- **Uses**: filesystem (`Bun.file` + `Bun.Glob`), `config.repos`, `session/types`
- **Used by**: `SessionManager.runClaudeWithAgent` (resolves definition, threads context profile through preamble building, composes system prompt)
