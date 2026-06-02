# Codex Runner

> Last audited 2026-05-15 against `src/` at `4aa25ab` (main) and `codex-cli 0.130.0`. Original draft 2026-04-28 against `codex-cli 0.125.0`.

## Problem

Junior currently assumes Claude Code is the only local coding agent. The execution layer, session IDs, streamed events, Slack status formatting, MCP wiring, and resume hints are all shaped around `claude -p --output-format stream-json`.

We want Junior to be able to run Codex as well, without forking the whole app or making Slack/session code understand every provider's native event format.

**Who has this problem:** Anyone who wants to choose Codex for a Junior thread, channel, or agent type.
**What happens today:** Junior always calls `spawnClaude()` and parses Claude stream-json.
**Painful part:** Codex has equivalents for the core runner features, but its CLI flags, JSONL stream schema, permissions model, and MCP configuration are different enough that it is not a drop-in replacement.
**"Finally" moment:** Junior can run either Claude or Codex behind the same session manager contract, while Slack still gets useful live status updates and final responses.

## Current Claude Surface

Junior's Claude-specific behavior lives primarily in `src/claude`:

- `args.ts` builds `claude` flags: `-p`, `--output-format stream-json`, `--verbose`, `--max-turns`, `--resume`, `--append-system-prompt`, `--model`, `--permission-mode`, `--mcp-config`.
- `spawner.ts` starts `claude`, selects cwd, injects Slack env (`SLACK_BOT_TOKEN`, `SLACK_CHANNEL`, `SLACK_THREAD_TS`) plus Junior env (`JUNIOR_SPAWNED=1`, `JUNIOR_AGENT_NAME`, identity vars `JUNIOR_SLACK_USERNAME` plus `JUNIOR_SLACK_ICON_EMOJI` or `JUNIOR_SLACK_ICON_URL`), parses stdout, captures session ID and final response.
- `parser.ts` parses Claude JSONL events.
- `types.ts` defines the event model consumed by session lifecycle and Slack formatting.

Claude assumptions also leak into:

- `src/session/manager.ts` imports `spawnClaude` and Claude event types.
- `src/slack/formatting.ts` expects Claude `assistant.message.content` blocks and `tool_use` blocks.
- `src/slack/home.ts` prints `claude --resume <sessionId>`.
- `src/lifecycle/timeout.ts` and several test files import Claude types directly.
- `src/config.ts` exposes only `config.claude` (`maxTurns`, `timeoutMs`, `permissionMode`, `defaultModel`).
- `src/agents/router.ts` looks for repo-local agent definitions under `.claude/agents`.
- `.mcp.json` at the junior repo root is passed to Claude with `--mcp-config`.

**Two behaviors worth preserving in any port:**

- **`session.cwd` override bypasses MCP config.** Spawner skips `--mcp-config` when `session.cwd` is set (utility commands need cloud integrations, not local MCP). The Codex spawner needs the same carve-out.
- **MCP config is project-wide, not per-thread.** Despite CLAUDE.md rule #9 saying "MCP config is per-thread", the spawner today reads a single `PROJECT_MCP_CONFIG` resolved from the junior repo root. Either fix the rule or fix the code before layering Codex on top of an unstated discrepancy.

## Codex Equivalents

Re-checked against `codex-cli 0.130.0`. Confirmed flags marked ✓; flags that drifted from the 0.125.0 draft are flagged.

| Junior/Claude usage | Codex equivalent | Notes |
|---|---|---|
| `claude -p <prompt>` | `codex exec <prompt>` | ✓ Non-interactive runner. |
| `--output-format stream-json` | `codex exec --json` | ✓ Emits JSONL with a different schema (see below). |
| `--resume <sessionId>` | `codex exec resume <session_id> <prompt>` | ✓ Accepts UUID or thread name; `--last` picks most recent. |
| Claude init `session_id` | `thread.started.thread_id` | Store in Junior's existing session ID field. |
| Claude final `result.result` | Last completed `agent_message`, or `--output-last-message <file>` | Prefer stream parsing for live Slack updates. |
| `--model <model>` | `-m, --model <model>` | ✓ Direct equivalent. |
| Process cwd | `-C, --cd <dir>` plus spawn cwd | Pass explicit `--cd` for clarity. New in 0.130.0: `--add-dir <DIR>` for extra writable dirs. |
| Image file paths in prompt | `-i, --image <FILE>...` | ✓ Variadic. Better than telling Codex to read paths manually. |
| `--permission-mode bypassPermissions` | `--sandbox workspace-write` + global `--ask-for-approval never` | **Drift:** `--full-auto` is no longer in `codex exec --help`. Don't depend on it. |
| `--mcp-config .mcp.json` | `-c key=value` overrides + `--ignore-user-config` | **New in 0.130.0**, see "MCP Configuration" — resolves the original "ephemeral config" open question. |
| `--append-system-prompt` | No CLI flag. Compose into first turn, or use `AGENTS.md` in the worktree | Same recommendation as 0.125.0. |
| `--max-turns` | No equivalent | Timeout remains Junior's outer guard. |

**Top-level vs per-exec flags — easy silent misconfig:** `--ask-for-approval` is a **global** flag. Place it before the subcommand: `codex --ask-for-approval never exec ...`. Putting it after `exec` won't error, but the approval policy may not apply.

## Codex JSONL Shape

Re-verified 2026-05-15 — the shape from the original draft is unchanged. `codex --ask-for-approval never exec --json --ephemeral --skip-git-repo-check --sandbox read-only "Reply exactly: OK"` emits:

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

Junior needs a Codex parser and a provider-neutral normalized event model. Pretending Codex events are Claude `assistant` events will make Slack formatting brittle.

## Proposed Architecture

Introduce a runner abstraction. **Status:** `src/runners/` does not yet exist. The whole abstraction is greenfield.

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

- Move `src/claude/*` under `src/runners/claude` as a thin port of the current implementation.
- Add `src/runners/codex` with its own args builder, parser, and spawner.
- Update `SessionManager` to depend on a `spawnRunner()` function rather than `spawnClaude()`.
- Update Slack formatting to consume normalized `RunnerEventTool` and `RunnerEventMessage`.
- Keep provider-native raw events inside adapter tests, not in app-level types.
- The Codex spawner must inject the same env vars the Claude spawner does today: `JUNIOR_SPAWNED`, `JUNIOR_AGENT_NAME`, `JUNIOR_SLACK_USERNAME`, `JUNIOR_SLACK_ICON_EMOJI` or `JUNIOR_SLACK_ICON_URL`, plus the Slack trio. Sub-agents read these to attribute Slack posts; missing them is a silent attribution bug.

## MCP Configuration

Current `.mcp.json` (unchanged):

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

Claude consumes this with `--mcp-config`. Codex doesn't accept Claude's file format, but **0.130.0's `-c key=value` overrides + `--ignore-user-config` together solve the ephemeral-config problem** that the original draft left open. Per-spawn:

```sh
codex --ask-for-approval never exec \
  --json --skip-git-repo-check --ignore-user-config \
  -c 'mcp_servers.slack-bot.url="http://localhost:3456/mcp"' \
  -c 'mcp_servers.slack-bot.transport="http"' \
  -c 'mcp_servers.playwright.command="npx"' \
  -c 'mcp_servers.playwright.args=["@playwright/mcp","--headless"]' \
  --sandbox workspace-write -m <model> "<prompt>"
```

This means:

- Junior never mutates the developer's `~/.codex/config.toml`.
- The MCP set per spawn is reproducible from the args alone.
- The original Iter 5 ("MCP parity") mostly collapses into Iter 2 ("args builder").

Remaining open: the **tool-name shape** Codex shows the model. Claude exposes MCP tools as `mcp__<server>__<tool>`. Verify Codex's naming so prompts and prohibitions still match.

**Alternative integration shape worth noting:** `codex mcp-server` (top-level subcommand new in 0.130.0) runs Codex itself as an MCP server. Junior could expose Codex as a tool to Claude rather than as a peer runner. That's a different architecture — flagged here, not planned.

## Agent Prompts

Claude supports `--append-system-prompt`, used for `.claude/agents/<agent>.md`. Codex still has no equivalent flag. Options:

1. Compose Junior's agent prompt into the first user prompt.
2. Generate an `AGENTS.md` in each worktree for Codex runs (`AGENTS.md` discovery is real in Codex).
3. Add Codex-specific agent definitions later if Codex-native subagent support becomes useful.

Recommended v1: compose the agent prompt into the first user prompt, preserving the existing `AgentRouter` behavior. Provider-independent, no per-worktree side effects.

## Permission Model

Claude today uses `--permission-mode bypassPermissions`. Codex 0.130.0 provides:

- `-s, --sandbox read-only`
- `-s, --sandbox workspace-write`
- `-s, --sandbox danger-full-access`
- `--dangerously-bypass-approvals-and-sandbox`
- global `--ask-for-approval never|on-request|untrusted` (note: top-level, not per-exec)

`--full-auto` from the original draft is **not** in `codex exec --help` output — treat it as removed. Use the explicit `--sandbox workspace-write` + `--ask-for-approval never` combination instead.

Recommended v1:

- For code worktrees: `--sandbox workspace-write` + global `--ask-for-approval never`.
- For read-only/review agents: `--sandbox read-only` + global `--ask-for-approval never`.
- Avoid `--dangerously-bypass-approvals-and-sandbox` unless Junior is running in an external sandbox.
- Keep Junior's worktree safety rule as the primary guard against editing shared repo roots.

## New Codex Flags Worth Knowing (0.125.0 → 0.130.0)

None of these existed when the original draft was written:

- `--ephemeral` — skip session persistence. Useful for one-shot reads.
- `--skip-git-repo-check` — needed when Junior runs in non-git cwds.
- `--ignore-user-config` — load no `~/.codex/config.toml`. Pair with `-c` for fully deterministic spawns.
- `--ignore-rules` — bypass project `.rules` execpolicy files.
- `--add-dir <DIR>` — extra writable dirs alongside primary workspace. Relevant for shared-workspace sub-agent flows.
- `--output-schema <FILE>` — JSON Schema for final response. Could replace ad-hoc parsing for structured agent results.
- `--enable <feature>` / `--disable <feature>` — feature flags surface; check `codex features` before relying on any.
- `-p, --profile` — config.toml profile selector. Conflicts notation-wise with Claude's `-p` (prompt); be careful in shared docs and helpers.

New top-level subcommands of interest (won't drive v1 but worth knowing):

- `codex mcp-server` — Codex as an MCP server (stdio).
- `codex apply` — apply Codex's last diff via `git apply`.
- `codex exec-server` (experimental) — long-lived exec service. Possible future to avoid per-message process spawn cost; not stable.

## Open Questions

| Question | Status |
|---|---|
| Provider selection global (`RUNNER_PROVIDER=codex`) or per thread (`!provider codex`)? | Open. |
| Should `session.sessionId` store provider-native IDs directly, or should `ThreadSession` gain `provider` and provider-specific session ID fields? | Leaning toward single `sessionId` + `provider: "claude" \| "codex"`. |
| Does Codex reliably persist and resume thread IDs in service mode? | Partial: `--ephemeral` for skip; default sessions persist under `$CODEX_HOME/sessions`. Verify perms when Junior runs as a service user. |
| Codex web search exposure? | Codex 0.130.0 `exec --help` no longer mentions `--search`. Either gone or moved behind feature flags (`--enable web-search`?). Verify before relying on. |
| Codex MCP tool naming shape? | Open. Claude uses `mcp__<server>__<tool>`. Run a spawn against the slack-bot MCP and read what Codex actually shows the model. |

Resolved since 0.125.0:

- **"Generate temporary Codex config per spawn":** answered by `-c` overrides + `--ignore-user-config`.
- **`--image` for Slack image attachments:** still recommended; flag confirmed.

## Iterations

### Iteration 0: Runner Contract (~45 min)

Extract provider-neutral runner types.

**What it adds:**
- `src/runners/types.ts` with `RunnerEvent`, `SpawnHandle`, `SpawnResult`.
- App-level code imports runner types, not Claude types.

**Test:** Existing Claude-path tests pass with behavior unchanged.

**Defers:** Codex spawning.

### Iteration 1: Port Claude Adapter (~45 min)

Move current Claude code under `src/runners/claude`.

**What it adds:**
- Claude adapter maps native Claude events to normalized runner events.
- Slack formatter consumes normalized events.
- `SessionManager` still defaults to Claude.
- `home.ts` resume hint still uses `claude --resume` (changes in Iter 4).

**Test:** Existing Claude parser/args tests pass after path updates. Slack formatting tests assert normalized tool status output.

**Defers:** Provider selection.

### Iteration 1.5: CLAUDE.md Alignment (~15 min)

Before adding a per-thread provider story, fix CLAUDE.md rule #9 ("MCP config is per-thread") to match the current single-`PROJECT_MCP_CONFIG` reality, **or** make the code per-thread first. Don't ship Codex on top of an unstated discrepancy.

### Iteration 2: Codex Args, Parser, MCP Injection (~1.5h)

Build the Codex CLI command and parse JSONL. (Original Iter 2 + Iter 5 merged — `-c` overrides collapse the MCP-parity work.)

**What it adds:**
- `buildCodexArgs(session, prompt, config)` emitting:
  - `-c mcp_servers.<name>.*` derived from `.mcp.json`
  - `--ignore-user-config`
  - `--json`, `--skip-git-repo-check`
  - `-m <model>`, `-C <cwd>`
  - sandbox flags (see Iter 3)
- `createCodexStreamParser()`:
  - `thread.started` → `RunnerEventInit`
  - `item.completed agent_message` → `RunnerEventMessage` and final-response candidate
  - `item.started` / `item.completed` `command_execution` → `RunnerEventTool` with status
  - `turn.completed` → `RunnerEventDone` with usage

**Test:** Unit tests using captured JSONL fixtures (capture fresh against the version being shipped — don't reuse 0.125.0 fixtures from this doc).

**Defers:** Real spawning.

### Iteration 3: Codex Spawner (~1h)

Spawn Codex non-interactively.

**What it adds:**
- `spawnCodex()`:
  - Top-level `--ask-for-approval never` (NOT per-exec).
  - `--sandbox workspace-write` for code worktrees, `--sandbox read-only` for review agents.
  - Supports fresh runs and `exec resume <thread_id> <prompt>`.
  - Sets cwd via spawn cwd plus `-C`.
  - Injects `JUNIOR_SPAWNED`, `JUNIOR_AGENT_NAME`, `JUNIOR_SLACK_USERNAME`, `JUNIOR_SLACK_ICON_EMOJI` or `JUNIOR_SLACK_ICON_URL`, `SLACK_BOT_TOKEN`, `SLACK_CHANNEL`, `SLACK_THREAD_TS`.
  - Honors the `session.cwd` override → no MCP injection (matches Claude carve-out).
  - Captures stderr and non-zero exits like Claude.

**Test:** Manual smoke test:

```sh
codex --ask-for-approval never exec --json --ephemeral --skip-git-repo-check --sandbox read-only -m <model> "Reply exactly: OK"
```

### Iteration 4: Provider Selection (~45 min)

Let Junior choose Claude or Codex.

**What it adds:**
- Config: `RUNNER_PROVIDER=claude|codex`, plus a `config.codex` block (`timeoutMs`, `defaultModel`, `defaultSandbox`).
- Optional command: `!provider claude|codex`.
- Home/status display includes provider.
- `home.ts` resume hint uses the correct CLI command per provider.

**Test:** Start one thread on Claude and one on Codex. Verify session IDs do not collide and resume commands are correct.

**Defers:** Per-agent provider defaults.

### Iteration 5: Attachments and Agent Prompt Polish (~1h)

Match Junior's existing Claude UX on Codex.

**What it adds:**
- Use `-i, --image` for Slack image attachments in Codex runs.
- Ensure agent prompt injection only happens on the first turn (composed into the first user message).
- On resumed turns, preserve the existing workspace safety block behavior.
- Verify Codex MCP tool-name shape — update prompts/prohibitions if the naming differs from Claude's `mcp__<server>__<tool>`.

**Test:** Slack image thread works with Codex. Build/review/support-lead prompts still apply across at least one Codex-driven thread.

## Risks

- Codex CLI is moving fast (0.125 → 0.130 in three weeks added several flags and removed `--full-auto`). Keep adapter tests fixture-based and small; recapture fixtures per release before relying on shape claims.
- Codex session persistence may depend on service-user permissions for `~/.codex/sessions`. Verify before assuming `exec resume` works in production.
- `-c key=value` overrides depend on TOML parsing on the CLI side. Quote values that contain shell metacharacters; one-line URL configs should be safe.
- Prompt-injected "system" behavior is weaker than a true system prompt flag.
- `--ask-for-approval` flag-position mistake (per-exec instead of global) is a silent permission misconfig, not an error. Add a test that asserts the flag's absolute position in `buildCodexArgs` output.
- Slack status updates will initially be less rich for Codex until more `item` types are mapped.

## Cut List

- Provider-specific subagent orchestration.
- Automatic migration of all `.claude/agents` into Codex-native files.
- Full Codex config management UI.
- Mixing Claude and Codex within the same persisted conversation.
- `danger-full-access` unattended mode.
- `codex mcp-server` integration (Codex-as-MCP-tool-for-Claude) — interesting but a different architecture.
- `codex exec-server` long-lived service — wait for stability.
