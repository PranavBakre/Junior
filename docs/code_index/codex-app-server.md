# Code Index: Codex App-Server Provider

The Codex provider adapts the Codex app-server protocol to Junior's normalized
runner boundary. It is selected with `RUNNER_PROVIDER=codex-app-server` and is
not the same as the historical standalone `src/codex` runner plan.

## Sources

| Area | Files | Purpose |
|---|---|---|
| Spawning and lifecycle | `src/codex-app-server/spawner.ts` | Starts the isolated Codex app-server process and exposes a runner handle. |
| Protocol parsing | `src/codex-app-server/parser.ts` | Parses JSONL app-server messages into normalized events. |
| Configuration | `src/codex-app-server/config.ts` | Builds app-server launch and MCP configuration. |
| Policy | `src/codex-app-server/policy.ts` | Maps sandbox, approval, search, and agent policy to Codex options. |
| Slack approval bridge | `src/mcp/slack-approval-bridge.ts`, `src/mcp/approval.ts` | Converts native app-server approval callbacks into blocking Slack Allow/Deny actions and defaults closed. |
| Shared boundary | `src/runners/types.ts`, `src/runners/index.ts` | Provider-neutral `SpawnHandle`, events, resume, and provider selection. |

## Configuration

`CODEX_MODE` defaults to `app-server`; sandbox and approval are controlled by
`CODEX_SANDBOX` and `CODEX_ASK_FOR_APPROVAL`. MCP, search, continuity,
isolated-home, model, and timeout flags are listed in [`.env.example`](../../.env.example).
The provider receives the same scoped Junior MCP contract as other normal
worktree-backed runs, subject to per-agent permissions.

Fresh threads preserve Codex's native `baseInstructions`. Junior's provider
baseline and composed active-agent prompt are additive
`developerInstructions`; replacing the native base prompt strips Codex's
tool/edit/persistence operating contract and is a provider-quality regression.
The client completes the documented `initialize` → `initialized` handshake
before starting or resuming a thread.

Generated Codex config sets `[features].multi_agent = false`; provider-native
subagents would bypass Junior's durable assignment, context, and settlement
contracts.

Native `requestApproval` server callbacks are not auto-denied. The provider
posts a scoped Allow/Deny action in the originating Slack thread, waits on the
same in-process resolver used by Claude's permission tool, and returns the
human decision using the exact callback schema: command and file callbacks
return `decision`, while permissions callbacks return the granted requested
`permissions` for the current turn. The pending resolver is registered before
the message or action records can become clickable. Missing context, post/store
errors, timeouts, and handler failures all deny the request and clear the
resolver. Each pending approval is also owned by the provider process: process
exit or an explicit stop aborts the resolver, disables any stored actions, and
removes the Slack buttons before a late click can grant access. JSON-RPC
responses are not written after the process enters a terminal state.

Codex continuity is provider-native and optional. Durable session, workflow,
pipeline, and artifact state remains authoritative when a process or provider
connection is restarted.
