# Scoped MCP via Delegate Agents (figma / notion gating)

**Status:** Implemented. Hosted OAuth MCPs are capability-gated per session;
the backlog item remains as historical context for the original design.

## Problem

PR #102 (figma) and the in-flight notion work wire remote OAuth MCP servers into
the Claude runner by **injecting them unconditionally** and **widening
`--setting-sources` to include `user` for every run**:

- `writeClaudeMcpConfig` always adds `figma` (and `notion`) to `mcpServers`,
  bypassing the `wantsMcp(session, ...)` permission gate that every other server
  (`slack-bot`, `playwright`, `mixpanel`, `mongodb`) respects
  (`src/claude/spawner.ts:185`).
- `needsUserSettings()` is hardcoded `true`, so `widenSettingSources()` prepends
  `user,` to setting sources on **every** Claude turn
  (`src/runners/mcp-config.ts:50`, `src/claude/spawner.ts:43`).

Two costs:

1. **Figma/notion leak into the default agent** — every worktree-backed turn
   gets these tools whether or not the agent should have them. This is
   inconsistent with the permission model and contradicts the `allowedMcpServers`
   allow-list (which lists `figma`/`notion` but is never consulted for them).
2. **The operator's entire `~/.claude` config loads into every agent session** —
   widening to `user` setting sources pulls in user-level hooks, permissions,
   env, and statusline for runs that have nothing to do with figma. Previously
   agents ran `project`-only and isolated.

The original motivation for the widening was that figma's OAuth tokens live at
the user level. But that motivation only applies to the one agent that actually
uses figma — not to every run.

## Background — what we learned

- **Remote figma/notion MCP are OAuth-only.** Tokens are stored at the **user
  level** — macOS Keychain (`Claude Code-credentials`), or
  `~/.claude/.credentials.json` / `~/.claude.json` on Linux. They are **not** in
  a relocatable project file, and the remote servers do **not** accept a static
  PAT via an `Authorization: Bearer` header. So "move the creds into the project"
  is not viable for the hosted servers. (PATs exist for Figma's REST API and the
  desktop dev-mode server, which needs the Figma app running — a non-starter on a
  headless host.)
- **OpenCode already does this correctly.** `buildOpenCodeMcpConfig` builds MCP
  per-turn into `OPENCODE_CONFIG_CONTENT`, fully gated by `wantsMcp`
  (`src/runners/index.ts:108`). Figma/notion are simply absent from that path
  today. The Claude path is the outlier to bring in line.
- **The permission lever already exists.** Agent `.md` frontmatter
  (`permissions.mcp:` or `mcp__<server>__*` entries in `tools:`) →
  `AgentDefinition.permissions` → `session.agentPermissions.mcp`
  (`src/session/manager.ts:1070`) → `allowedMcpServers()` /
  `wantsMcp()` (`src/runners/mcp-config.ts:12`).

## Implementation

1. `writeClaudeMcpConfig` and the generated OpenCode/Codex configs add Figma or
   Notion only when `wantsMcp(session, ...)` is true.
2. `needsUserSettings(session)` is true only for a session requesting Figma or
   Notion. Claude widens `--setting-sources` only for those non-utility runs;
   default and utility sessions retain project-only settings isolation.
3. OpenCode and Codex expose the same capability-gated servers. Their optional
   `OPENCODE_FIGMA_MCP_ENABLED`, `OPENCODE_NOTION_MCP_ENABLED`,
   `CODEX_FIGMA_MCP_ENABLED`, and `CODEX_NOTION_MCP_ENABLED` flags provide an
   operator kill switch (default enabled, still requiring `wantsMcp`).
4. The root `.mcp.json` contains only the local Slack server. The interactive
   `bin/claude-with-mcp.sh` launcher defaults hosted OAuth servers off; set
   `CLAUDE_MCP_FIGMA=true` or `CLAUDE_MCP_NOTION=true` for an explicit manual
   OAuth test.

No dedicated agent is created by this change. Existing trusted agent
definitions can opt in through `permissions.mcp: figma` and/or `notion`; this
keeps OAuth authority explicit at the agent boundary instead of silently
granting it to the default orchestrator.

## Open questions

- **Is the widening even necessary?** The credential research suggests MCP OAuth
  tokens (keychain on macOS) may load **independently** of `--setting-sources`.
  If figma authorizes with `--setting-sources project`, the entire
  `needsUserSettings` / `widenSettingSources` machinery can be **deleted** rather
  than made session-aware. **Verify first** with `bin/claude-with-mcp.sh`
  (`CLAUDE_MCP_FIGMA=true`, force `--setting-sources project`, confirm figma
  tools still authorize) before building step 2.
- **One delegate agent or per-tool agents?** A single `designer` agent holding
  both figma and notion, vs. separate agents. Leaning toward one delegate that
  owns design/doc integrations to keep the widened-settings surface minimal.
- **Should figma/notion ever be available to the default agent at all,** or is
  delegation always required? The runtime now requires an explicit capability;
  the trusted catalog decides which agent receives that capability.
- **Identity registration** for the new agent (Star Trek naming convention; org
  overlay vs. public `.claude/agents/`).

## Non-goals

- Project-scoping the OAuth credentials themselves (not viable for the hosted
  remote MCP servers — see Background).
- Relocating Claude config via `CLAUDE_CONFIG_DIR` (relocates *all* config for
  the subprocess; disproportionate to the problem).
