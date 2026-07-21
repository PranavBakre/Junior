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
| Shared boundary | `src/runners/types.ts`, `src/runners/index.ts` | Provider-neutral `SpawnHandle`, events, resume, and provider selection. |

## Configuration

`CODEX_MODE` defaults to `app-server`; sandbox and approval are controlled by
`CODEX_SANDBOX` and `CODEX_ASK_FOR_APPROVAL`. MCP, search, continuity,
isolated-home, model, and timeout flags are listed in [`.env.example`](../../.env.example).
The provider receives the same scoped Junior MCP contract as other normal
worktree-backed runs, subject to per-agent permissions.

Codex continuity is provider-native and optional. Durable session, workflow,
pipeline, and artifact state remains authoritative when a process or provider
connection is restarted.
