# Codex Runner

## Problem

Junior currently assumes Claude Code is the only local coding agent. The execution layer, session IDs, streamed events, Slack status formatting, MCP wiring, and resume hints are all shaped around `claude -p --output-format stream-json`.

We want Junior to be able to run Codex as well, without forking the whole app or making Slack/session code understand every provider's native event format.

**Who has this problem:** Anyone who wants to choose Codex for a Junior thread, channel, or agent type.
**What happens today:** Junior always calls `spawnClaude()` and parses Claude stream-json.
**Painful part:** Codex has equivalents for the core runner features, but its CLI flags, JSONL stream schema, permissions model, and MCP configuration are different enough that it is not a drop-in replacement.
**"Finally" moment:** Junior can run either Claude or Codex behind the same session manager contract, while Slack still gets useful live status updates and final responses.

## Current Claude Surface

Junior's Claude-specific behavior lives primarily in `src/claude`:

- `args.ts` builds `claude` flags: `-p`, `--output-format stream-json`, `--resume`, `--append-system-prompt`, `--model`, `--permission-mode`, `--mcp-config`, `--max-turns`.
- `spawner.ts` starts `claude`, selects cwd, injects Slack env vars, parses stdout, captures session ID and final response.
- `parser.ts` parses Claude JSONL events.
- `types.ts` defines the event model consumed by session lifecycle and Slack formatting.

Claude assumptions also leak into:

- `src/session/manager.ts` imports `spawnClaude` and Claude event types.
- `src/slack/formatting.ts` expects Claude `assistant.message.content` blocks and `tool_use` blocks.
- `src/slack/home.ts` prints `claude --resume <sessionId>`.
- `src/config.ts` exposes only `config.claude`.
- `src/agents/router.ts` looks for repo-local agent definitions under `.claude/agents`.
- `.mcp.json` is passed to Claude with `--mcp-config`.

## Codex Equivalents

Checked locally against `codex-cli 0.125.0`.

| Junior/Claude usage | Codex equivalent | Notes |
|---|---|---|
| `claude -p <prompt>` | `codex exec <prompt>` | Non-interactive runner. |
| `--output-format stream-json` | `codex exec --json` | Emits JSONL, but with a different schema. |
| `--resume <sessionId>` | `codex exec resume <thread_id> <prompt>` | Codex calls this `thread_id` in JSONL. |
| Claude init `session_id` | `thread.started.thread_id` | Store this in Junior's existing session ID field or a provider-specific field. |
| Claude final `result.result` | Last completed `agent_message`, or `--output-last-message <file>` | Prefer stream parsing for live Slack updates. |
| `--model <model>` | `--model <model>` / `-m` | Direct equivalent. |
| Process cwd | `--cd <dir>` / `-C <dir>` plus spawn cwd | Keep existing cwd policy, but pass explicit `--cd` for clarity. |
| Image file paths in prompt | `--image <file>` | Better than telling Codex to read image paths manually. |
| `--permission-mode bypassPermissions` | `--full-auto`, or `--sandbox workspace-write --ask-for-approval never` | Needs an explicit Junior trust policy. |
| `--mcp-config .mcp.json` | Codex config TOML / `codex mcp add` | Codex does not consume Claude's `.mcp.json` directly. |
| `--append-system-prompt` | No direct CLI flag | Compose agent prompt into the first turn, or use `AGENTS.md` where appropriate. |
| `--max-turns` | No obvious equivalent | Timeout remains Junior's outer guard. |

## Codex JSONL Shape

Codex `exec --json` emits events like:

```json
{"type":"thread.started","thread_id":"019dd2c8-5b26-7d70-b7a1-89232b0f9db9"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}
{"type":"turn.completed","usage":{"input_tokens":11536,"cached_input_tokens":10112,"output_tokens":26,"reasoning_output_tokens":19}}
```

When Codex runs a shell command:

```json
{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc pwd","aggregated_output":"","exit_code":null,"status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"/bin/zsh -lc pwd","aggregated_output":"/Users/psbakre/Projects/junior\n","exit_code":0,"status":"completed"}}
```

This means Junior needs a Codex parser and a provider-neutral normalized event model. Trying to pretend Codex events are Claude `assistant` events will make Slack formatting brittle.

## Proposed Architecture

Introduce a runner abstraction:

```ts
export type RunnerProvider = "claude" | "codex";

export interface RunnerEventInit {
  type: "init";
  provider: RunnerProvider;
  sessionId: string;
}

export interface RunnerEventMessage {
  type: "message";
  provider: RunnerProvider;
  text: string;
}

export interface RunnerEventTool {
  type: "tool";
  provider: RunnerProvider;
  name: string;
  input: Record<string, unknown>;
  status?: "started" | "completed";
}

export interface RunnerEventDone {
  type: "done";
  provider: RunnerProvider;
  usage?: Record<string, unknown>;
}

export type RunnerEvent =
  | RunnerEventInit
  | RunnerEventMessage
  | RunnerEventTool
  | RunnerEventDone;

export interface SpawnResult {
  provider: RunnerProvider;
  sessionId: string | null;
  response: string;
  events: RunnerEvent[];
  exitCode: number | null;
  error: string | null;
}
```

Then:

- Keep `src/runners/claude` as a thin port of the current `src/claude` implementation.
- Add `src/runners/codex` with its own args builder, parser, and spawner.
- Update `SessionManager` to depend on a `spawnRunner()` function rather than `spawnClaude()`.
- Update Slack formatting to consume normalized `RunnerEventTool` and `RunnerEventMessage`.
- Keep provider-native raw events inside adapter tests, not in app-level types.

## MCP Configuration

Current `.mcp.json`:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp", "--headless"]
    },
    "slack-bot": {
      "type": "http",
      "url": "http://localhost:3456/mcp"
    }
  }
}
```

Claude consumes this with `--mcp-config`.

Codex needs equivalent config in Codex's MCP registry/config TOML. The local CLI supports:

```sh
codex mcp add slack-bot --url http://localhost:3456/mcp
codex mcp add playwright -- npx @playwright/mcp --headless
```

Challenges:

- `codex mcp list` currently reports no configured MCP servers.
- Junior should not rely on a developer's personal global config being correct.
- The safest path is to generate or maintain a project-local `.codex/config.toml` if Codex will honor it for trusted projects, or document a one-time setup step.
- Need to verify Codex MCP tool names shown to the model. Claude tools appear as `mcp__slack-bot__*`; Codex naming may differ.

## Agent Prompts

Claude supports `--append-system-prompt`, which Junior uses for `.claude/agents/<agent>.md`.

Codex does not expose a direct `--append-system-prompt` flag in the local CLI. Options:

1. Compose Junior's agent prompt into the first user prompt.
2. Generate an `AGENTS.md` in each worktree for Codex runs.
3. Add Codex-specific agent definitions later if Codex-native subagent support becomes useful.

Recommended v1: compose the agent prompt into the first user prompt, preserving the existing `AgentRouter` behavior. This keeps named Junior agents provider-independent.

## Permission Model

Claude today uses:

```sh
--permission-mode bypassPermissions
```

Codex provides:

- `--sandbox read-only`
- `--sandbox workspace-write`
- `--sandbox danger-full-access`
- `--full-auto`
- `--dangerously-bypass-approvals-and-sandbox`
- global `--ask-for-approval never|on-request|untrusted`

Recommended v1:

- For code worktrees: `--sandbox workspace-write --ask-for-approval never`.
- For read-only/review agents: `--sandbox read-only --ask-for-approval never`.
- Avoid `--dangerously-bypass-approvals-and-sandbox` unless Junior is running in an external sandbox.
- Keep Junior's own worktree safety rule as the primary guard against editing shared repo roots.

## Open Questions

- Should provider selection be global (`RUNNER_PROVIDER=codex`) or per thread (`!provider codex`)?
- Should `session.sessionId` store provider-native IDs directly, or should `ThreadSession` gain `provider` and provider-specific session ID fields?
- Does Codex reliably persist and resume thread IDs in the environment where Junior runs as a service?
- Should Codex image attachments use `--image` instead of the current prompt text path list?
- Can we generate a temporary Codex config per spawn to avoid mutating global `~/.codex/config.toml`?
- How should Codex web search be exposed? It has `--search`, while Claude behavior depends on tools/config.

## Iterations

### Iteration 0: Runner Contract (~45 min)

Extract provider-neutral runner types.

**What it adds:**
- `src/runners/types.ts`
- `RunnerEvent` normalized event model
- `SpawnHandle` and `SpawnResult` moved out of `src/claude/types.ts`
- App-level code imports runner types, not Claude types

**Test:** Existing tests pass with Claude behavior unchanged.

**Defers:** Codex spawning.

### Iteration 1: Port Claude Adapter (~45 min)

Move current Claude code under `src/runners/claude`.

**What it adds:**
- Claude adapter maps native Claude events to normalized runner events.
- Slack formatter consumes normalized events.
- `SessionManager` still defaults to Claude.

**Test:** Existing Claude parser/args tests pass after path updates. Slack formatting tests assert normalized tool status output.

**Defers:** Provider selection.

### Iteration 2: Codex Args and Parser (~1h)

Build the Codex CLI command and parse JSONL.

**What it adds:**
- `buildCodexArgs(session, prompt, config)`
- `createCodexStreamParser()`
- Parse `thread.started` as init.
- Parse `item.completed agent_message` as message/final response candidate.
- Parse `item.started/item.completed command_execution` as tool status.
- Parse `turn.completed` as done/usage.

**Test:** Unit tests using captured JSONL fixtures for plain response and command execution.

**Defers:** Real spawning with MCP.

### Iteration 3: Codex Spawner (~1h)

Spawn Codex non-interactively.

**What it adds:**
- `spawnCodex()`
- Supports fresh runs and `exec resume`.
- Sets cwd/`--cd`.
- Passes model.
- Applies sandbox/approval config.
- Captures stderr and non-zero exits like Claude.

**Test:** Manual smoke test:

```sh
codex --ask-for-approval never exec --json --ephemeral --skip-git-repo-check --sandbox read-only -m gpt-5.4-mini "Reply exactly: OK"
```

**Defers:** Full MCP parity.

### Iteration 4: Provider Selection (~45 min)

Let Junior choose Claude or Codex.

**What it adds:**
- Config: `RUNNER_PROVIDER=claude|codex`
- Optional command: `!provider claude|codex`
- Home/status display includes provider.
- Resume hint uses the correct CLI command.

**Test:** Start one thread on Claude and one on Codex. Verify session IDs do not collide and resume commands are correct.

**Defers:** Per-agent provider defaults.

### Iteration 5: MCP Parity (~1-2h)

Make Slack bot and Playwright tools available to Codex runs.

**What it adds:**
- Document or generate Codex MCP config equivalent to `.mcp.json`.
- Verify `slack-bot` tools are visible in Codex.
- Ensure `SLACK_BOT_TOKEN`, `SLACK_CHANNEL`, and `SLACK_THREAD_TS` are still passed to child processes.

**Test:** Ask Codex to send a thread message via the Slack MCP tool from a worktree-backed run.

**Defers:** Codex-specific cloud integrations.

### Iteration 6: Attachments and Agent Prompt Polish (~1h)

Make Codex behavior match Junior's existing UX.

**What it adds:**
- Use `--image` for Slack image attachments in Codex runs.
- Ensure agent prompt injection only happens on the first turn.
- On resumed turns, preserve the existing workspace safety block behavior.

**Test:** Slack image thread works with Codex. Build/review/support-lead prompts still apply.

## Risks

- Codex CLI behavior may evolve; keep adapter tests fixture-based and small.
- Codex session persistence may depend on service user permissions for `~/.codex/sessions` or SQLite state.
- Global Codex config is user-specific; Junior needs a deterministic MCP setup story.
- Prompt-injected "system" behavior is weaker than a true system prompt flag.
- Slack status updates will initially be less rich for Codex until more item types are mapped.

## Cut List

- Provider-specific subagent orchestration.
- Automatic migration of all `.claude/agents` into Codex-native files.
- Full Codex config management UI.
- Mixing Claude and Codex within the same persisted conversation.
- `danger-full-access` unattended mode.
