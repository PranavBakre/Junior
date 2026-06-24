# Scoped MCP via Delegate Agents (figma / notion gating)

**Status:** Scoping — deferred. Tracked in [v2-backlog.md](./v2-backlog.md#scoped-mcp-via-delegate-agents).

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

## Scope (to be refined)

1. **Gate figma/notion behind `wantsMcp`.** Replace the unconditional injection
   in `writeClaudeMcpConfig` with `if (wantsMcp(session, "figma")) { ... }` (and
   notion), matching every other server. Drop the now-dead distinction in the
   `allowedMcpServers` allow-list.
2. **Make widening session-aware.** Change `needsUserSettings()` to take the
   session and return `true` only when the session's agent wants a user-OAuth
   server (figma/notion). Result: only the delegate agent's runs widen
   setting-sources; the default agent and all others return to `project`-only
   isolation.
3. **Add a dedicated delegate agent** (e.g. `designer`) at
   `.claude/agents/designer.md` with `permissions.mcp: figma` (and/or `notion`),
   that Junior's default agent routes to via `!designer`. This is where the
   user-OAuth widening is contained.
4. **OpenCode parity.** Add figma/notion to `buildOpenCodeMcpConfig` gated by
   `wantsMcp` + a `config.opencode.figmaMcpEnabled` flag, mirroring the
   slack-bot/mongodb pattern, so the delegate agent works under both providers.

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
  delegation always required? Delegation-only keeps the blast radius smallest.
- **Identity registration** for the new agent (Star Trek naming convention; org
  overlay vs. public `.claude/agents/`).

## Non-goals

- Project-scoping the OAuth credentials themselves (not viable for the hosted
  remote MCP servers — see Background).
- Relocating Claude config via `CLAUDE_CONFIG_DIR` (relocates *all* config for
  the subprocess; disproportionate to the problem).
