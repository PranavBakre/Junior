# Codex Provider Plan

> **Historical implementation plan.** Codex app-server is implemented under `src/codex-app-server` and selected with `RUNNER_PROVIDER=codex-app-server`. This document preserves the earlier decision record; current behavior is indexed in [`../code_index/codex-app-server.md`](../code_index/codex-app-server.md).

Date: 2026-05-25

This document plans a Codex runner provider for Junior after the stacked PRs
#52 through #59:

- #52-#57: associative memory store, ingestion, access surfaces, live wiring,
  consolidation workflow, and docs.
- #58: session idle interrupt and resume.
- #59: OpenCode SDK/server provider.

It supersedes the older Codex-only runner notes as an implementation plan, but
keeps their verified CLI findings where they still match the installed Codex
CLI.

## Historical recommendation

Build a **Codex app-server provider first if and only if Phase 0 proves config,
hook, and MCP isolation**. Keep a **Codex CLI provider as the fallback path** if
that isolation cannot be made deterministic.

Do not use `codex mcp-server` as the Junior provider. That command exposes
Codex as an MCP tool to another host; Junior needs Codex to be the coding-agent
runner behind Slack sessions, not a nested tool hidden behind another provider.

The recommended provider split is:

| Provider | Timing | Purpose |
|---|---|---|
| `codex-app-server` | v1 target | Long-lived Codex control plane using `thread/start`, `turn/start`, `turn/interrupt`, streamed notifications, and `thread/resume`. This is the closest match to OpenCode SDK/server. |
| `codex` | fallback | One process per Slack turn using `codex exec --json` and `codex exec resume --json` if app-server isolation is not production-safe. |

Reasoning:

- Junior already has a provider-neutral runner boundary on `main`.
- The stacked `opencode-sdk` provider proves the right shape for server-backed
  providers: separate provider value, same normalized events, same cwd/env/MCP
  contract, and provider-native abort.
- Codex app-server 0.133.0 exposes the primitives Junior needs and a local smoke
  test proved the core thread lifecycle: initialize, start with developer
  instructions, stream message/tool notifications, interrupt a turn, and resume
  the same thread.
- App-server also exposes `baseInstructions` / `developerInstructions`, which is
  materially better for Junior's dynamic agent prompts than CLI prompt wrapping.
- Official Codex docs describe app-server as the deep-integration interface for
  authentication, conversation history, approvals, and streamed agent events:
  https://developers.openai.com/codex/app-server
- Official Codex docs also confirm subagent workflows. Codex can spawn
  specialized agents in parallel when explicitly instructed, and app-server
  exposes `collabToolCall` items for those collaborative agent calls:
  https://developers.openai.com/codex/concepts/subagents
- The blocker is not capability. The remaining production requirement is
  isolation: app-server inherits user Codex hooks and global MCP startup from
  `$CODEX_HOME`, but local smoke tests showed `JUNIOR_SPAWNED=1` suppresses the
  learnings hook payload and a separate minimal `CODEX_HOME` suppresses user
  hooks and user MCP servers.
- Codex CLI remains useful as a fallback because it has stable enough one-turn
  primitives and an `--ignore-user-config` flag, but it is weaker on prompt
  injection and native abort.
- Junior should also ship a manual operator helper, analogous to
  `bin/opencode-with-mcp.sh`, so a human can talk to Codex with the same
  Junior-owned `CODEX_HOME`, prompt/config assumptions, and MCP set that the
  provider uses.

## App-Server Smoke Result

Verified locally on 2026-05-25 with `codex-cli 0.133.0` using
`scripts/codex-app-server-smoke.mjs`.

Proved:

- `initialize` works over stdio JSON-RPC.
- `thread/start` accepts `cwd`, `model`, `approvalPolicy`, `sandbox`,
  `baseInstructions`, and `developerInstructions`.
- `developerInstructions` had real behavioral effect: the model included the
  injected marker in its response.
- `turn/start` works with text input.
- App-server emits usable normalized-provider source events:
  `thread/started`, `turn/started`, `item/started`, `item/completed`,
  `item/agentMessage/delta`, `turn/completed`, `thread/status/changed`, and
  `thread/tokenUsage/updated`.
- `turn/interrupt` works and produced a completed turn with status
  `interrupted`.
- `thread/resume` works for non-ephemeral threads and a follow-up `turn/start`
  completed in the same thread.
- Command execution items expose structured fields including command, cwd,
  status, aggregated output, exit code, and duration.
- Slack MCP works through a Junior-owned `CODEX_HOME` with only Junior-approved
  MCP config. The smoke emitted an `mcpToolCall` item for
  `server: "slack-bot"` and `tool: "slack_send_message"`; app-server asked for
  MCP tool-call elicitation, and accepting that request allowed the message to
  post.
- Image input works through app-server `localImage` for JPEG files and for a
  second PNG retest from `~/Downloads`. An earlier PNG produced
  `unsupported image image/png`, so Junior should treat image failures as
  per-file validation/runtime errors rather than assuming PNG is unsupported.

Also discovered:

- `ephemeral: true` threads cannot be resumed from disk; the server returns
  `no rollout found for thread id ...`. Junior Slack sessions must use
  persisted app-server threads.
- User-level Codex hooks were loaded into the thread and produced
  `hook/started`, `hook/completed`, a `hookPrompt` item, and a command execution
  attempting to read `/Users/psbakre/.codex/hooks/learnings-prompt.txt`.
- Passing `--config hooks.enabled=false` did **not** stop that hook from loading
  in the smoke test.
- Running with `JUNIOR_SPAWNED=1` still emitted `hook/started` /
  `hook/completed`, but the learnings hook exited early: no `hookPrompt`, no
  learnings command execution, and the final response was clean.
- User/global MCP configuration also started: stderr showed a Figma MCP auth
  failure from the user Codex environment. Junior must not allow unrelated user
  MCPs into Slack-runner turns.
- Running app-server with `CODEX_HOME=/tmp/junior-codex-home-smoke`, a minimal
  `config.toml`, and auth copied or symlinked from the real Codex home
  succeeded. It removed user hook events, removed user MCP startup, and left
  only the built-in `codex_apps` MCP startup notifications.

Conclusion: app-server covers the important OpenCode parity gaps and should be
the primary Codex provider target. The required isolation strategy is now
concrete: spawn app-server with `JUNIOR_SPAWNED=1`, a Junior-owned `CODEX_HOME`,
minimal generated config, and auth linked or copied from the real Codex home.
The remaining work is implementation, fixture coverage, and soak. Native
idle-timeout interrupt/resume recovery should be feature-flagged so operators
can run Codex conservatively until that path is needed. Normal `thread/resume`
for completed turns remains part of the app-server provider contract.

## Current Junior Features Codex Must Preserve

The Codex provider is not only "run a model from Slack." It must preserve these
Junior features.

### Slack Session Semantics

- One `ThreadSession` per Slack thread.
- A top-level session for default Junior/lead and independent `AgentSession`
  rows for persistent workers.
- Buffer while busy, then drain buffered messages on completion.
- `!cancel`, `!reset`, `!provider`, `!driver`, verbosity, mute, dormant, and
  catch-up behavior remain owned by `SessionManager`.
- Final responses are posted through `SlackResponder`, with `NO_SLACK_MESSAGE`
  suppression and duplicate Slack MCP post suppression.

Codex impact: the adapter must emit the same normalized `RunnerEvent`s and
return the same `SpawnResult` fields as Claude/OpenCode.

### Persistent Agents and Dispatch

- Orchestrators (`lead`, `default`) can emit `!<agent>` directives.
- Workers get their own provider-native session id and Slack identity.
- Worker sessions may run concurrently in one Slack thread.
- Agent definitions resolve from target repo `.claude/agents`, private
  `agents-org`, then public fallback.
- Agent frontmatter can set model, identity, context profile, tools, and
  provider permission intent.

Codex impact: every worker session must carry `provider: "codex"` and its own
Codex session id. Switching a thread to Codex must not mix a previous Claude or
OpenCode session id into Codex resume.

### Agent Frontmatter Permission Mapping

Codex app-server must honor the permissions Junior specifies for an agent. Do
not run every Codex agent with one global app-server policy if the active
agent's frontmatter asks for a narrower or broader tool surface.

Required mapper:

- Parse permission-related frontmatter into `AgentDefinition` alongside the
  existing `tools`, `model`, identity, and context fields.
- Map Junior/Claude-style `tools` and permission intent to Codex app-server
  `approvalPolicy`, `sandboxPolicy`, and MCP/tool availability.
- Preserve least privilege by default. If a frontmatter value cannot be mapped
  safely, fail closed or require approval rather than silently widening access.
- Apply the mapped policy at `thread/start` / `thread/resume` and each
  `turn/start`, because app-server allows per-turn settings and those settings
  become defaults for later turns on the same thread.
- Add unit tests for the mapper before enabling Codex provider wiring.

Suggested initial mapping:

| Junior agent intent | Codex app-server mapping |
|---|---|
| read-only/investigation agent | `sandboxPolicy.type = "readOnly"` and restrictive approval policy |
| normal build agent | `sandboxPolicy.type = "workspaceWrite"` limited to the active cwd/worktree |
| human-gated mutating agent | `workspaceWrite` plus approval requests for command/file changes |
| utility cwd agent | apply the utility MCP carve-out unless the agent explicitly requests Slack/memory tools |
| no shell/tool permission | read-only sandbox and no shell/dynamic-tool allowance where Codex exposes that control |

Open item: decide the exact frontmatter key names before implementation. The
current loader parses `tools` but not a first-class permissions object; Codex
implementation should add a typed field rather than re-parsing raw frontmatter
inside the provider.

### Prompt and Persona Surface

Claude uses `--append-system-prompt`. OpenCode uses generated
`OPENCODE_CONFIG_CONTENT` with `agent.build.prompt`.

Codex app-server should use `baseInstructions` and `developerInstructions` for
Junior's composed provider baseline, core prompt, active agent prompt, recalled
memory context, and Slack/worktree constraints. This is the v1 target because
it gives Junior a real instruction channel.

Codex CLI still has no equivalent system-prompt flag in 0.133.0. If the CLI
fallback is implemented, it should wrap Junior's composed agent prompt into the
first user turn:

```text
<junior-runtime>
You are Junior running inside Codex as a Slack-controlled coding agent.
...
</junior-runtime>

<junior-agent-prompt>
...composed agent definition and common preamble...
</junior-agent-prompt>

<user-request>
...Slack/user prompt...
</user-request>
```

Rules:

- Inject the full agent prompt on a fresh Codex session.
- On resume, send only the normal resumed-turn workspace/catch-up block and the
  new user request unless `needsThreadCatchup` requires thread history.
- Do not write generated `AGENTS.md` files into target worktrees for v1.
- Do not depend on project `AGENTS.md` as the only source of Junior's agent
  identity. Target repo instructions are useful context, not Junior's dynamic
  persona transport.

Codex should still not replace OpenCode as default until real Slack-thread soak
proves prompt salience and config isolation across normal Junior workflows.

### Worktrees and Cwd

Codex must use the shared runner runtime policy:

```text
session.cwd ?? session.worktreePath ?? targetRepoCwd ?? process.cwd()
```

Rules:

- Pass `--cd <cwd>` (`-C`) and also spawn with `cwd`.
- Create `session.cwd` when set, matching `buildRunnerRuntime`.
- Never silently run code-changing tasks in a bare shared origin checkout when a
  worktree is expected.
- Preserve the utility cwd carve-out: when `session.cwd` is set, skip Junior's
  local Slack/Playwright/Mixpanel/MongoDB MCP wiring.

### MCP and Tools

Junior currently exposes:

- Slack MCP from `src/mcp/slack-server.ts`
- Playwright MCP
- Conditional Mixpanel MCP for `feature-metrics`
- Conditional MongoDB MCP for `db-executioner`
- Memory MCP tools after the memory stack
- Provider-native support subagents for stateless observability prompts

Codex app-server should run from a Junior-owned `CODEX_HOME` whose generated
`config.toml` contains only Junior-approved MCP servers. This is preferable to
running against the operator's real `~/.codex/config.toml`, because global MCPs
are eagerly surfaced during app-server startup.

CLI fallback can still use config overrides:

```sh
codex \
  --ask-for-approval never \
  --sandbox workspace-write \
  --cd "$cwd" \
  exec \
  --json \
  --skip-git-repo-check \
  --ignore-user-config \
  -c 'mcp_servers.slack-bot.transport="http"' \
  -c 'mcp_servers.slack-bot.url="http://localhost:3456/mcp"' \
  -c 'mcp_servers.playwright.command="npx"' \
  -c 'mcp_servers.playwright.args=["@playwright/mcp","--headless"]' \
  "$prompt"
```

Open items to verify with fixtures:

- Codex MCP config key names for HTTP/remote servers in 0.133.0.
- Codex's surfaced MCP tool names. Claude uses
  `mcp__<server>__<tool>`; OpenCode may nest the concrete tool name inside
  input. Slack duplicate-post suppression must recognize the Codex shape.
- Whether memory MCP tools are available in Codex runs through the same config
  path as Slack/Playwright.

### Provider-Native Subagents

OpenCode currently has native support-subagent behavior for stateless
observability prompts. Codex is not missing this category: official Codex docs
describe explicit subagent workflows, and the app-server schema exposes
`collabToolCall` items with sender/receiver/new thread fields.

Codex impact:

- Treat provider-native subagents as covered by app-server, pending a Junior
  fixture.
- Add mapper coverage for `collabToolCall` so status pills can show delegated
  agent work without confusing it with Junior's persistent Slack worker agents.
- Keep Junior's own persistent workers as separate `AgentSession` rows. Codex
  subagents are an internal provider capability for one Codex turn; they should
  not replace Junior's Slack-addressable agents or their persisted session ids.
- Make subagent use explicit in Junior's provider baseline, matching Codex's
  documented behavior: the model should spawn subagents only when the task or
  Junior agent prompt asks for delegation or parallel agent work.

### Streaming and Status

Codex CLI JSONL emits:

```json
{"type":"thread.started","thread_id":"..."}
{"type":"turn.started"}
{"type":"item.started","item":{"type":"command_execution","command":"...","status":"in_progress"}}
{"type":"item.completed","item":{"type":"agent_message","text":"..."}}
{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}
```

The Codex parser should map:

| Codex event | Junior event |
|---|---|
| `thread.started.thread_id` | `init` |
| completed `agent_message.text` | `message` and final response candidate |
| `item.started` / `item.completed` for command/tool-like items | `tool` with `started` / `completed` |
| `mcpToolCall` items | `tool`, preserving `server`, `tool`, `arguments`, and `result` for Slack duplicate-post suppression |
| `collabToolCall` items | `tool`, preserving delegated-agent metadata for provider-native subagent status |
| `userMessage.content.localImage` | accepted input fixture; surface per-file validation/runtime failures clearly |
| `turn.completed.usage` | `done.usage` |

### Codex Tool Event Shape

Codex app-server tool events are different from OpenCode events. The Codex
provider must have a dedicated JSON-RPC notification listener and item mapper;
do not reuse the OpenCode JSONL parser or assume OpenCode `tool_use` / `part`
shapes.

Codex app-server emits tool-like work as `item/started`, `item/completed`, and
provider-specific progress notifications around typed items. The mapper should
normalize these item types into Junior `RunnerEventTool` events:

| Codex item type | Junior tool mapping |
|---|---|
| `commandExecution` | `tool`, preserving command, cwd, status, output, exit code, and duration |
| `mcpToolCall` | `tool`, preserving server, tool, arguments, result, and error for MCP status and Slack duplicate-post suppression |
| `dynamicToolCall` | `tool`, preserving dynamic tool name, arguments, result, and status |
| `collabToolCall` | `tool`, preserving provider-native subagent metadata, sender/receiver/new thread ids, and status |
| `webSearch` | `tool`, preserving query/result summary where surfaced |
| `fileChange` | `tool` or structured status event, preserving changed path/action metadata |

Listener requirements:

- Subscribe to all app-server notifications, not only text deltas.
- Treat `item/started` as `status: "started"` and `item/completed` as
  `status: "completed"` where the item is tool-like.
- Handle progress notifications such as MCP tool-call progress without
  producing duplicate completed events.
- Preserve Codex-native metadata inside `RunnerEventTool.input`; Slack/session
  code should still only see the normalized `RunnerEvent` union.
- Log unknown item types at INFO with the item type and notification method.
- Add fixtures for every known tool-like item type before enabling Slack soak.

Parser requirements:

- Incremental JSONL parser with a partial-line buffer.
- Log unknown event types at INFO and known malformed shapes at WARN.
- Keep native fixtures under `src/codex/*.test.ts`.
- Do not leak Codex-native event schemas into session/slack code.

### Idle Interrupt and Resume

After #58, all Slack sessions get idle interruption and resume attempts. The
Codex app-server provider must support that path:

- `kill("SIGINT")` should call `turn/interrupt` when a turn id is known and
  `CODEX_APP_SERVER_CONTINUITY_ENABLED=true`.
- `kill("SIGKILL")` should hard-stop the app-server process or daemon session.
- If app-server emitted a thread id before idle interruption and
  `CODEX_APP_SERVER_CONTINUITY_ENABLED=true`, `SessionManager` can continue by
  sending another `turn/start` on the same resumed thread.
- If no session id was emitted, idle recovery should fail with a concrete
  runner error rather than starting a new unrelated Codex conversation.

The local smoke test proved `turn/interrupt` produces a completed turn with
status `interrupted`, so app-server closes the native abort gap that exists in
the CLI path. Keep it off by default until a real Slack soak proves it is
operationally worth enabling.

### Dynamic Workflows

Workflows can run a provider from `/tmp/junior-utility`, declare tools, and
optionally use idle recovery. Codex must support:

- `runner.provider: codex` once implemented.
- `runner.provider: codex-app-server` once implemented.
- `runner.provider: default` when the global default is Codex.
- Utility cwd with no Junior MCP wiring unless the workflow explicitly needs
  memory or Slack tools.
- Long-running memory consolidation with idle resume only when
  `CODEX_APP_SERVER_CONTINUITY_ENABLED=true`.
- Final result as Slack mrkdwn.

Codex's `--output-schema` is worth testing for future structured workflow
outputs, but v1 should keep the same final-text contract.

### Associative Memory

After #52-#57, memory affects routing and context:

- Hot-path Slack capture remains deterministic and should not add LLM calls.
- Memory recall is available through HTTP/MCP/CLI.
- Memory consolidation runs offline as a workflow.
- Agent selection may be memory-informed.

Codex impact:

- The provider should not directly own memory policy.
- It must expose memory MCP/CLI access when the current Junior run would expose
  it to OpenCode/Claude.
- Codex app-server developer instructions should include recalled memory only
  where the existing session/router layer already injects it.

## Codex CLI 0.133.0 Surface

Verified locally on 2026-05-25:

```text
codex-cli 0.133.0
```

Relevant commands:

- `codex exec --json [PROMPT]`
- `codex exec resume --json [SESSION_ID] [PROMPT]`
- `codex review`
- `codex mcp`
- `codex mcp-server`
- `codex app-server` (experimental)
- `codex remote-control` (experimental)
- `codex exec-server` (experimental)

Relevant global flags:

- `--model`
- `--sandbox read-only|workspace-write|danger-full-access`
- `--ask-for-approval untrusted|on-failure|on-request|never`
- `--search`
- `--cd <DIR>`
- `--add-dir <DIR>`
- `--image <FILE>...`
- `--config key=value`
- `--ignore-user-config` under `exec` / `resume`

Important details:

- `--ask-for-approval` is top-level. Put it before `exec`.
- `--cd` is top-level in 0.133.0. Existing docs that use `--cd` after `exec`
  should be rechecked during implementation.
- `exec` reads stdin if no prompt is supplied or if prompt is `-`. Junior should
  pass the prompt positionally and set child stdin to `ignore`.
- If stdin is piped while a prompt is also supplied, Codex appends stdin as a
  `<stdin>` block. This is exactly what Junior should avoid in a service
  process.
- `--search` exists again in 0.133.0 and enables the native Responses web search
  tool. Treat it as a config knob, not always-on default.

## App Server / Exec Server Assessment

Codex 0.133.0 exposes:

- `codex app-server --listen stdio://|unix://|ws://IP:PORT|off`
- `codex app-server daemon start|restart|stop|version|...`
- `codex app-server proxy`
- `codex app-server generate-ts --out <dir> [--experimental]`
- `codex app-server generate-json-schema --out <dir> [--experimental]`
- `codex exec-server --listen ws://IP:PORT|stdio`
- `codex remote-control start|stop`

The local smoke test moves app-server from "interesting future spike" to
"primary implementation candidate." It covers session creation, turn execution,
developer instruction injection, streaming, interruption, and resume.

The remaining app-server research is narrower and more important:

1. Find a deterministic isolation strategy for user hooks, user MCPs, plugins,
   skills, and global config. A separate `CODEX_HOME` with minimal config and
   linked/copied auth works in the local smoke test; the implementation still
   needs a durable auth strategy.
2. Capture a committed Slack MCP call fixture from app-server events and wire
   duplicate-post suppression to identify `mcpToolCall.server/tool` values such
   as `slack-bot` / `slack_send_message`.
3. Capture committed image input fixtures using `UserInput { type:
   "localImage" }` for both JPEG and PNG. JPEG and one PNG retest work locally;
   an earlier PNG failed, so provider errors should identify the specific file.
4. Capture a committed `collabToolCall` fixture for Codex subagents.
5. Confirm daemon/socket lifecycle and auth if Junior uses `unix://` or managed
   daemon mode instead of spawning a stdio server process.
6. Decide whether `exec-server` adds anything useful over app-server. Current
   evidence favors app-server because its protocol is thread/turn oriented and
   already exposes developer instructions and turn interruption.

The provider should follow the #59 OpenCode SDK pattern as a separate provider
value, not mutate the CLI provider into two modes.

## Manual Operator Helper

Junior should include a `bin/codex-with-junior-home.sh` or
`bin/codex-app-server-with-junior-home.sh` helper before the provider is marked
operational.

Purpose:

- Let an operator manually talk to Codex using the same Junior-owned
  `CODEX_HOME` that spawned Slack agents use.
- Make manual debugging match production behavior: same auth source, same
  minimal config, same trust entry for the Junior repo, same MCP toggles, and
  `JUNIOR_SPAWNED=1`.
- Avoid the current mismatch where a manual Codex run sees personal hooks,
  personal plugins, and global MCP servers while Junior's provider should not.
- Provide a known-good command for debugging a stuck app-server thread or
  reproducing provider behavior outside Slack.

The helper should mirror `bin/opencode-with-mcp.sh`:

- Parse boolean env flags the same way `src/config.ts` does.
- Create or refresh `CODEX_ISOLATED_HOME_PATH` if missing.
- Write a minimal generated `config.toml`.
- Symlink, not copy, the real `auth.json` where possible.
- Export `JUNIOR_SPAWNED=1`.
- Exec either `codex app-server --listen stdio://` for protocol debugging or
  `codex app <path>` / `codex` for an interactive manual session, depending on
  the script variant.
- Never read personal `~/.codex/hooks.json`, personal MCP servers, or personal
  plugins unless the operator explicitly opts in.

This script is not convenience polish. It is part of the provider contract:
operators need a way to reproduce the same Codex environment that Junior agents
use, otherwise debugging will happen against the wrong tool surface.

## Soak Definition

In this document, "soak" means repeated real runs over time that exercise token
refresh, app-server lifecycle, and Junior's Slack workflows under the same
isolated `CODEX_HOME`.

Minimum soak before enabling `codex-app-server` as a supported provider:

- Run the app-server smoke script with symlinked auth at least daily across an
  auth refresh boundary. The concern is upstream issue #15410: copied
  `auth.json` can become stale after refresh-token rotation.
- Restart Junior/app-server and verify `thread/resume` still works for a
  persisted non-ephemeral thread.
- Verify no personal hook events, no personal MCP startup, and no personal
  plugin/skill loading across runs.
- Run one real Slack thread each for default Junior, `!build`, `!review`, and a
  persistent worker agent.
- Run one idle-interrupt flow and verify `turn/interrupt` plus follow-up
  `turn/start` continues cleanly.
- Run one workflow from `/tmp/junior-utility`.
- Run one Slack MCP post and verify duplicate-post suppression sees the
  app-server `mcpToolCall` item shape.
- Run one image attachment flow through `localImage`.

Soak is not a vague waiting period. It is a checklist proving the isolated
Codex home remains authenticated and clean while Junior exercises the paths it
uses in production.

## Proposed Implementation Plan

### Phase 0: App-Server Isolation

Prove Junior can run app-server without inheriting unrelated user Codex state.

Deliverables:

- Extend `scripts/codex-app-server-smoke.mjs` or add a focused fixture script
  that starts app-server under an isolated `CODEX_HOME`.
- Preserve auth, but suppress user hooks, user MCP servers, user plugins, and
  unrelated global config.
- Verify notifications do not include `hook/started`, `hook/completed`,
  unrelated `mcpServer/startupStatus/updated`, or unrelated command executions.
  Built-in `codex_apps` startup notifications are allowed.

Exit criteria:

- The smoke thread starts, runs, interrupts, resumes, and completes with no
  unrelated hooks or MCP servers entering the turn.
- The isolation mechanism is reproducible from Junior config, not an operator's
  shell state.
- Auth survives token refresh. A copied `auth.json` works for a short smoke test,
  but upstream issue #15410 documents that copied auth can break after refresh;
  prefer a symlinked auth file or another shared-auth strategy if it remains
  reliable in soak.
- Add the manual `bin/codex-*with-junior-home.sh` helper so operators can use
  the same isolated Codex home outside Slack.

### Phase 1: App-Server Protocol Fixtures

Add fixture-backed mappers before wiring app code.

Deliverables:

- `src/codex-app-server/parser.ts` or mapper module.
- `src/codex-app-server/parser.test.ts`.
- Fixtures for thread start, agent message deltas, command execution,
  `mcpToolCall`, `dynamicToolCall`, provider-native subagent `collabToolCall`,
  `webSearch`, `fileChange`, image input, interrupted turn, resumed turn, and
  error.

Exit criteria:

- App-server notifications map to `RunnerEvent` without importing Slack/session
  code.
- Unknown notification methods are logged, not silently dropped.

### Phase 2: App-Server Config

Suggested config:

```ts
codex: {
  mode: "app-server" | "cli";
  model: string | null;
  timeoutMs: number;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  askForApproval: "untrusted" | "on-request" | "never";
  searchEnabled: boolean;
  appServerContinuityEnabled: boolean;
  mcpEnabled: boolean;
  slackMcpEnabled: boolean;
  playwrightMcpEnabled: boolean;
  mixpanelMcpEnabled: boolean;
  mongodbMcpEnabled: boolean;
  memoryMcpEnabled: boolean;
  isolatedHomePath: string | null;
}
```

Suggested env names:

- `CODEX_MODE`
- `CODEX_MODEL`
- `CODEX_TIMEOUT_MS`
- `CODEX_SANDBOX`
- `CODEX_ASK_FOR_APPROVAL`
- `CODEX_SEARCH_ENABLED`
- `CODEX_APP_SERVER_CONTINUITY_ENABLED`
- `CODEX_MCP_ENABLED`
- `CODEX_SLACK_MCP_ENABLED`
- `CODEX_PLAYWRIGHT_MCP_ENABLED`
- `CODEX_MIXPANEL_MCP_ENABLED`
- `CODEX_MONGODB_MCP_ENABLED`
- `CODEX_MEMORY_MCP_ENABLED`
- `CODEX_ISOLATED_HOME_PATH`

Exit criteria:

- `RUNNER_PROVIDER=codex-app-server` parses only after the spawner lands.
- Config tests cover model, sandbox, approval, app-server continuity toggle, MCP toggles, utility cwd, and isolated Codex home.
- Agent permission mapper tests cover frontmatter-to-Codex approval/sandbox/MCP
  settings, including fail-closed behavior for unmapped permissions.

### Phase 3: `spawnCodexAppServer`

Implement the app-server provider.

Responsibilities:

- Use `buildRunnerRuntime`.
- Start or attach to app-server over stdio or `unix://`.
- Send `initialize`.
- Use `thread/start` for fresh sessions.
- Use `thread/resume` for existing non-ephemeral sessions, including after a
  Junior/app-server restart. `CODEX_APP_SERVER_CONTINUITY_ENABLED` does not gate
  normal completed-turn resume.
- Use `baseInstructions` / `developerInstructions` for Junior's provider
  baseline, core prompt, and active agent prompt.
- Apply the active agent's mapped frontmatter permissions to app-server thread
  and turn settings.
- Use `turn/start` for each Slack turn.
- Use `turn/interrupt` for idle timeout / cancel only when
  `CODEX_APP_SERVER_CONTINUITY_ENABLED=true`; otherwise fall back to hard-stopping
  the provider process for cancel/timeout.
- Inject the same Junior/Slack env vars as other providers.
- Map notifications to normalized `RunnerEvent`.
- Use agent message deltas/completed items as final response candidates.
- Keep non-ephemeral app-server threads for Slack session resume.
- Support local image inputs and surface per-file app-server validation errors
  clearly. Add conversion only for formats app-server actually rejects in
  fixtures or soak.
- Handle app-server elicitation requests, at minimum MCP tool approval requests,
  according to Junior's approval policy.

Exit criteria:

- Unit tests pass.
- Local app-server smoke test returns a thread id/session id and response.
- Interrupt smoke test yields turn status `interrupted` when the continuity flag
  is enabled, and hard-stop behavior is covered when the flag is disabled.
- Resume smoke test continues the same app-server thread regardless of the
  continuity flag. The flag only gates idle-timeout interrupt/resume recovery.

### Phase 4: Provider Wiring

Update:

- `RunnerProvider` / `ImplementedRunnerProvider`
- `parseRunnerProvider`
- `runnerTimeoutMs`
- `spawnRunner`
- `!provider` validation and tests
- session SQLite demotion tests that currently demote persisted `codex` to
  `claude`
- README/env docs

Exit criteria:

- `RUNNER_PROVIDER=codex-app-server` starts Junior.
- `!provider codex-app-server` works in a thread.
- Existing Claude/OpenCode tests remain green.

### Phase 5: Slack and MCP Soak

Run Codex through real Junior workflows:

- Plain message in `#junior`
- `!build`
- `!review`
- `!reproducer` with image attachments
- Slack MCP post with `NO_SLACK_MESSAGE`
- Slack duplicate-post suppression
- `!cancel`
- idle interruption and resume
- explicit Codex subagent prompt that emits `collabToolCall`
- workflow run from `/tmp/junior-utility`
- memory recall/consolidation access where enabled

Exit criteria:

- No prompt/context leaks in Slack errors.
- Status pills show useful tool progress.
- Persistent agents keep independent Codex session ids.
- Worktree safety is preserved.

### Phase 6: CLI Fallback

Implement `codex` CLI only if app-server isolation fails or if operators need a
minimal fallback.

Deliverables:

- `src/codex/args.ts`
- `src/codex/parser.ts`
- `src/codex/spawner.ts`
- Fresh/resume/image/MCP/idle tests using `codex exec --json`.

The CLI fallback should stay a separate provider mode because its prompt
strategy is weaker: it has to wrap Junior's system prompt into user text.

## Coverage Report Against OpenCode Support

| Feature | Current OpenCode support | Codex app-server coverage | Provider work needed |
|---|---|---|---|
| Fresh Slack turn | Implemented via OpenCode SDK/server spawn | Covered by `thread/start` + `turn/start` smoke | Add `spawnCodexAppServer` and parser fixtures |
| Resume | Implemented through provider session id | Covered for non-ephemeral app-server threads, but disabled unless `CODEX_APP_SERVER_CONTINUITY_ENABLED=true` | Persist Codex thread ids and gate `thread/resume` behind the flag |
| Idle interrupt / cancel | Implemented with provider-native abort path | Covered by `turn/interrupt` smoke, but disabled unless `CODEX_APP_SERVER_CONTINUITY_ENABLED=true` | Gate `turn/interrupt`; hard-stop process when disabled |
| Streaming messages | Implemented normalized `RunnerEvent`s | Covered by `item/agentMessage/delta` and completed `agentMessage` | Map deltas/completed items to final response candidate |
| Tool and command status | Implemented for OpenCode events | Covered by `commandExecution`, `mcpToolCall`, `dynamicToolCall`, `fileChange`, `webSearch` items | Add item mappers and unknown-item logging |
| Dynamic prompt/persona | Implemented through generated OpenCode config | Better covered by `baseInstructions` / `developerInstructions` | Move Junior prompt composition into app-server instruction fields |
| Agent frontmatter permissions | Partly represented through agent config/tools | Covered by app-server per-thread/per-turn settings | Add typed permission parsing and a mapper to Codex `approvalPolicy`, `sandboxPolicy`, and MCP/tool availability |
| Cwd/worktree policy | Implemented through shared runner runtime | Covered by app-server `cwd` fields | Reuse `buildRunnerRuntime`; add tests |
| Isolated provider config | Implemented through OpenCode env/config generation | Covered by separate Junior-owned `CODEX_HOME` smoke | Generate minimal `config.toml`, symlink auth, block personal hooks/MCP/plugins |
| Learnings hook suppression | Not applicable to OpenCode | Covered: `JUNIOR_SPAWNED=1` exits the hook early; isolated home removes hook events | Always export `JUNIOR_SPAWNED=1`; prefer isolated home |
| Slack MCP | Implemented through Junior MCP config | Covered by real `slack_send_message` smoke | Commit fixture; map `mcpToolCall` for duplicate-post suppression |
| MCP elicitation | OpenCode flow depends on its event surface | Covered by app-server server requests in smoke | Implement request handler with Junior approval policy |
| Playwright/Mixpanel/MongoDB/Memory MCP | Implemented conditionally in OpenCode config | Expected through generated Codex `config.toml`; Slack MCP path proved | Generate per-session MCP config and add fixtures |
| Image attachment | OpenCode support depends on current attachment path | Covered for JPEG and at least one PNG via `localImage`; one earlier PNG failed | Add JPEG/PNG fixtures and clear per-file error handling |
| Junior persistent agents | Implemented as separate `AgentSession`s | Covered by independent Codex threads per worker | Persist provider id per worker; prevent cross-provider resume |
| Provider-native subagents | Implemented for OpenCode support-subagent prompts | Covered by Codex docs and app-server `collabToolCall` schema | Add explicit subagent fixture and mapper; keep distinct from Junior workers |
| Workflows | Implemented for OpenCode and Claude | Covered by same runner boundary once provider is wired | Add workflow provider enum/config/tests |
| Manual operator parity | Implemented for OpenCode via `bin/opencode-*` scripts | Not implemented yet | Add `bin/codex-with-junior-home.sh` / app-server helper |

Net: no currently documented OpenCode feature appears fundamentally uncovered by
Codex app-server. The remaining gaps are implementation and hardening gaps:
parser/mappers, isolated `CODEX_HOME` generation, MCP config generation,
elicitation handling, image fixture coverage, subagent fixture coverage, provider
wiring, and soak. The only reason to keep the CLI fallback is operational risk
around experimental app-server lifecycle/auth behavior, not feature coverage.

## Provider Interface Impact

The existing provider interface does **not** need a shape change for Codex
app-server.

Existing fields are sufficient:

- `SpawnRunnerFn(..., imagePaths?: string[])` already has the image attachment
  input Codex needs. The Codex provider can pass supported local images as
  app-server `localImage` content and report file-specific validation errors.
- `SpawnResult.sessionId` can store the Codex app-server thread id. Junior
  already treats provider-native session ids as opaque strings.
- `SpawnHandle.onEvent` and `RunnerEvent` already support streaming normalized
  events. App-server notifications can be mapped into the existing `init`,
  `message`, `tool`, and `done` events.
- `RunnerEventTool.input: Record<string, unknown>` is intentionally broad enough
  for Codex `mcpToolCall`, `commandExecution`, `dynamicToolCall`, and
  `collabToolCall` metadata. No new event variant is required for subagents.
- `SpawnHandle.kill(): void` can remain synchronous. When
  `CODEX_APP_SERVER_CONTINUITY_ENABLED=true`, the Codex provider should fire
  `turn/interrupt` when a turn id is known and let `result` settle from the
  app-server `turn/completed` notification. When the flag is disabled, or if
  there is no active turn id, it should hard-stop the underlying stdio process.
- `SpawnHandle.pid: number | null` already allows daemon/socket-backed
  providers to return `null` if Junior is not tracking a direct child process.

Required changes are enum/config/wiring changes, not interface changes:

- Add `codex-app-server` to the provider unions once the spawner lands.
- Keep `codex` as the CLI fallback/planned provider unless/until implemented.
- Add Codex config and MCP config generation.
- Add parser/mappers and fixture tests for app-server notification shapes.
- Update Slack duplicate-post suppression tests for Codex `mcpToolCall` input
  shape.
- Update workflow provider validation to accept `codex-app-server` after the
  provider is implemented.

## Risk Register

| Risk | Mitigation |
|---|---|
| Prompt salience under Codex differs from OpenCode/Claude | Keep OpenCode default until Slack soak. Use app-server instruction fields for v1; reserve XML prompt wrapping for CLI fallback only. |
| Codex CLI flag drift | Version-gate docs/tests against `codex --version` and keep args tests narrow. |
| MCP config key mismatch | Capture real MCP call fixtures before enabling by default. |
| Session id mix across providers | On provider switch, clear provider-native session id unless explicit migration is implemented. |
| Idle interruption loses in-flight state | Require a Codex thread id before retry; app-server `turn/interrupt` is the v1 abort path. |
| Utility workflows accidentally inherit Junior MCP | Preserve `session.cwd` carve-out. |
| Slack duplicate posts via MCP | Extend `isDuplicateSlackToolResponse` tests with Codex MCP tool event shape. |
| App-server inherits user hooks/global MCP | Phase 0 isolated `CODEX_HOME` or equivalent must pass before provider wiring. |
| App-server security ambiguity | Use stdio for first implementation or document/authenticate `unix://` daemon mode before production. |

## Decision

Use **Codex app-server as the v1 target**, with **Codex CLI as fallback**:

- App-server now has local smoke evidence for the major OpenCode parity
  features: developer instructions, native interrupt, streaming notifications,
  command items, persisted thread ids, resume, Slack MCP, JPEG/PNG image input, and
  provider-native subagent surface.
- The first implementation blocker is deterministic isolation from user hooks
  and global MCP servers, not app-server capability.
- CLI remains a simpler fallback but should not be the primary path if
  app-server isolation is solved.
