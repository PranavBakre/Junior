# Slack Bot → Claude Code Orchestrator

## Feature Doc — Internal

**Author:** Pranav Bakre
**Status:** Design / RFC
**Date:** April 2026

---

## Problem

We want a Slack bot that acts as the control plane for Claude Code sessions. The server owns the lifecycle — not the user, not Claude. When a message arrives in a Slack thread, the bot either spawns a new Claude Code instance or routes the message to an existing one. Each thread gets its own isolated session with its own worktree, skills, and MCP config.

This is the inverse of Channels (where Claude Code is the parent and messaging apps push events _into_ it). Here, the Slack bot server is the parent. Claude Code is a subprocess it spawns, manages, and kills.

---

## Architecture

```
Slack Event API (message.channels, app_mention)
    │
    ▼
┌─────────────────────────────────┐
│         Slack Bot Server        │
│         (Node.js / Bun)         │
│                                 │
│  ┌───────────────────────────┐  │
│  │     Session Manager       │  │
│  │                           │  │
│  │  Map<thread_id, {         │  │
│  │    sessionId,             │  │
│  │    worktreePath,          │  │
│  │    proc (if bidirectional)│  │
│  │    pendingMessages[],     │  │
│  │    status: idle | busy    │  │
│  │  }>                       │  │
│  └───────────────────────────┘  │
│                                 │
│  On message:                    │
│    1. Look up thread_id         │
│    2. If busy → buffer message  │
│    3. If idle → spawn claude    │
│    4. On exit → drain buffer    │
│                                 │
└────────────┬────────────────────┘
             │ spawns
             ▼
┌─────────────────────────────────┐
│    Claude Code CLI Process      │
│                                 │
│  claude -p "<prompt>"           │
│    --resume <session_id>        │
│    --worktree <thread_id>       │
│    --output-format stream-json  │
│    --mcp-config <per-thread>    │
│    --append-system-prompt "..." │
│    --allowedTools "..."         │
│    --max-turns 25               │
└─────────────────────────────────┘
```

---

## Core Design Decisions

### 1. CLI subprocess, not SDK

The SDK (`@anthropic-ai/claude-code` used as a library) requires API keys — usage-based billing. The CLI authenticates via `claude.ai` OAuth and runs on a Max subscription. Since Example Org runs on Max, we use the CLI as a subprocess.

### 2. `--resume` for conversation continuity (not long-lived processes)

Each Slack message spawns a short-lived `claude -p` process. The `--resume <session_id>` flag picks up the same conversation from the last completed turn. No need to keep processes alive between messages.

```
thread msg 1 → spawn claude -p "msg" → get session_id → store → exit
thread msg 2 → spawn claude -p "msg" --resume <session_id> → exit
thread msg 3 → spawn claude -p "msg" --resume <session_id> → exit
```

Session IDs are extracted from the first `stream-json` event on stdout.

### 3. Single-turn request-response model

`-p` mode is single-turn. Claude receives a prompt, does its work (tool calls, file edits, bash internally), and returns one final response. The process then exits.

Claude cannot "send multiple messages" mid-execution. What you can do:

- **Stream events:** `--output-format stream-json` emits structured events (tool calls, thinking steps, file edits) as Claude works. The bot can parse these and post incremental updates to Slack (e.g., "editing file X...", "running tests...").
- **Multi-turn via `--resume`:** Each Slack message is a new turn. Conversation context is preserved across turns via the session.

### 4. Buffering over interruption

If Claude is mid-execution on a thread and new messages arrive, we buffer them — not interrupt.

**Why not interrupt:**

- Killing a process mid-execution risks corrupted session state. `--resume` relies on the last turn completing cleanly.
- `SIGINT` is the graceful option, but there's no guarantee the interrupted turn's context gets fully saved.
- Interruption makes the system nondeterministic.

**Buffer + batch pattern:**

```typescript
const sessions = new Map<
  string,
  {
    sessionId: string | null;
    worktreePath: string;
    status: "idle" | "busy";
    pendingMessages: Array<{ user: string; text: string }>;
  }
>();

async function handleSlackMessage(
  threadId: string,
  user: string,
  text: string,
) {
  const session = sessions.get(threadId);

  if (session?.status === "busy") {
    session.pendingMessages.push({ user, text });
    // React with 👀 in Slack so user knows it's queued
    await slack.reactions.add({ name: "eyes", channel, timestamp });
    return;
  }

  await runClaude(threadId, text, user);
}

async function runClaude(threadId: string, text: string, user: string) {
  const session = sessions.get(threadId) || createSession(threadId);
  session.status = "busy";

  const args = buildClaudeArgs(session, text);
  const proc = spawn("claude", args, { cwd: session.worktreePath });

  let response = "";
  // parse stream-json from stdout for session_id and response text

  proc.on("exit", async () => {
    session.status = "idle";
    await postToSlack(threadId, response);

    // drain pending messages as one combined prompt
    if (session.pendingMessages.length > 0) {
      const pending = session.pendingMessages.splice(0);
      const combined = pending.map((m) => `[${m.user}]: ${m.text}`).join("\n");
      await runClaude(threadId, combined, "multiple");
    }
  });
}
```

Multiple messages that arrive while Claude is working get batched into the next turn with attribution (`[user]: message`). From the Slack UX: users see their messages acknowledged (👀 react), then get one coherent response that addresses everything.

---

## Worktree Isolation

### Two-workspace model

There are two distinct workspaces at play:

1. **Junior's workspace** (this repo — `junior/`) — shared across all threads. Contains CLAUDE.md, learnings, agent definitions, bot server code. Never isolated per thread.
2. **Target repo workspace** (e.g., `example-backend/`, `example-frontend/`) — isolated per thread when threads do code work on the same repo. Without isolation, concurrent sessions edit the same files and collide.

Junior's own workspace is shared so that learnings, CLAUDE.md improvements, and memory accumulate across all threads. Conversation continuity per thread comes from `--resume <sessionId>`, not filesystem isolation.

### Why worktrees (for target repos only)

Git worktrees give each thread its own checkout of the target repo — own branch, own working directory, shared git history. Two threads working on example-backend can edit different files without collision.

### Manual worktree management

The bot creates worktrees in the TARGET repo (not in junior's own repo):

```typescript
import { execSync } from "child_process";

function createWorktree(
  repoPath: string,
  threadId: string,
  baseRef: string = "origin/main",
) {
  const worktreePath = `${repoPath}/.claude/worktrees/slack-${threadId}`;
  const branchName = `slack/${threadId}`;

  execSync(`git worktree add ${worktreePath} -b ${branchName} ${baseRef}`, {
    cwd: repoPath,
  });

  return worktreePath;
}

function removeWorktree(repoPath: string, threadId: string) {
  const worktreePath = `${repoPath}/.claude/worktrees/slack-${threadId}`;
  execSync(`git worktree remove ${worktreePath} --force`, {
    cwd: repoPath,
  });
}
```

Then spawn Claude with `cwd` set to the worktree path:

```bash
claude -p "msg" --resume <sessionId> --output-format stream-json
# spawned with { cwd: worktreePath }  ← worktree in TARGET repo
```

The target repo's own `.claude/agents/` definitions are available in the worktree — no need to duplicate them in junior.

### Threads that don't need code isolation

Some threads don't edit code — they ask questions, review docs, or discuss architecture. These threads can run with `cwd` set to junior's own workspace (shared) or the target repo's main checkout (read-only). No worktree needed.

The bot should only create worktrees when a thread will make code changes. This can be:
- Explicit: user says `/build` or `/branch feature-x`
- Deferred: start without a worktree, create one when Claude's first tool call is a file edit

### Worktree lifecycle

- **Created** when a thread needs code isolation (first code-editing message, or explicit `/branch` command).
- **Reused** on subsequent messages — the session stores `worktreePath` and spawns Claude with that `cwd`.
- **Cleanup** — when the Slack thread goes stale (configurable timeout, e.g., 24h of inactivity), the bot checks for uncommitted changes. If clean, runs `git worktree remove`. If dirty, warns the thread before cleanup.

### WorktreeCreate hook (advanced)

For custom branching logic (e.g., always branch from `staging` for certain threads), configure a `WorktreeCreate` hook in settings. The hook replaces Claude Code's default `git worktree` logic entirely.

---

## Skill & MCP Isolation

### Per-thread MCP config

Each spawned process can get its own MCP server configuration. Create a JSON file per thread (or per use-case) and pass it via `--mcp-config`:

```bash
claude -p "msg" \
  --mcp-config /path/to/configs/slack-support.mcp.json \
  --output-format stream-json
```

Example `slack-support.mcp.json` — only the MCP servers relevant to support tasks:

```json
{
  "mcpServers": {
    "org-docs": {
      "command": "node",
      "args": ["/path/to/docs-mcp-server/index.js"],
      "env": { "DOCS_ROOT": "/path/to/shared-docs" }
    }
  }
}
```

Global MCP servers (from `~/.claude/settings.json`) are **not** loaded when `--mcp-config` is passed — the flag is exclusive.

### Per-thread CLAUDE.md (skills + context)

Create a temporary workspace per thread with a curated `CLAUDE.md`:

```typescript
function createThreadWorkspace(threadId: string, skillSet: string) {
  const workspace = `/tmp/claude-workspaces/${threadId}`;
  mkdirSync(workspace, { recursive: true });

  // copy in only the skills relevant to this thread's purpose
  const claudeMd = getClaudeMdForSkillSet(skillSet);
  writeFileSync(`${workspace}/CLAUDE.md`, claudeMd);

  // optionally copy .claude/settings.json with specific allowedTools
  const settings = {
    permissions: {
      allowedTools: ["Read", "Write", "Bash(git *)"],
      deny: ["Bash(rm -rf *)"],
    },
  };
  mkdirSync(`${workspace}/.claude`, { recursive: true });
  writeFileSync(`${workspace}/.claude/settings.json`, JSON.stringify(settings));

  return workspace;
}
```

### `--append-system-prompt` for lightweight scoping

For quick behavior scoping without touching files:

```bash
claude -p "msg" \
  --append-system-prompt "You are a Example Org support agent. Only answer questions about the platform. Do not write production code." \
  --output-format stream-json
```

### `--allowedTools` / `--disallowedTools` for tool scoping

```bash
claude -p "msg" \
  --allowedTools "Read,Bash(git log:*),Bash(git diff:*)" \
  --disallowedTools "Bash(rm:*),Bash(sudo:*)" \
  --output-format stream-json
```

### Combining all three

The full spawn command for a thread with full isolation:

```bash
claude -p "<prompt>" \
  --resume <session_id> \
  --worktree "slack-${threadId}" \
  --mcp-config /path/to/thread-specific.mcp.json \
  --append-system-prompt "You are ..." \
  --allowedTools "Read,Write,Bash(git *)" \
  --disallowedTools "Bash(rm -rf *),Bash(sudo *)" \
  --max-turns 25 \
  --output-format stream-json
```

---

## Bidirectional Communication (Experimental)

### `--input-format stream-json`

There is an undocumented `--input-format stream-json` flag that allows sending structured JSON messages on stdin. Combined with `--output-format stream-json`, this enables true bidirectional streaming — send input, read streaming output, send follow-up, all within one process.

**Status:** As of April 2026, this flag exists but is undocumented. The expected stdin format, valid message types, multi-turn conversation flow, and permission prompt handling are all unspecified. There is an open GitHub issue (#24594) requesting documentation. The Agent SDK docs cover the equivalent streaming input protocol, but the CLI-specific behavior may differ.

**If/when this is documented**, the architecture simplifies significantly:

```
Slack message → write JSON to proc.stdin → read response from proc.stdout
```

No more spawn-per-message. One long-lived process per thread. But until the protocol is stable and documented, `--resume` is the safer bet.

---

## Streaming Updates to Slack

With `--output-format stream-json`, Claude emits structured events as it works:

```jsonl
{"type":"system","subtype":"init","session_id":"abc-123",...}
{"type":"assistant","subtype":"tool_use","tool":"Bash","input":{"command":"git diff"}}
{"type":"assistant","subtype":"text","text":"I found 3 issues..."}
{"type":"result","subtype":"success","text":"Here's what I found:..."}
```

The bot can parse these and post incremental updates:

```typescript
proc.stdout.on("data", (chunk) => {
  const lines = chunk.toString().split("\n").filter(Boolean);
  for (const line of lines) {
    const event = JSON.parse(line);

    if (event.type === "system" && event.subtype === "init") {
      session.sessionId = event.session_id;
    }

    if (event.type === "assistant" && event.subtype === "tool_use") {
      // post ephemeral "running: git diff..." to slack
      postEphemeral(
        threadId,
        `⚙️ ${event.tool}: ${event.input?.command || "..."}`,
      );
    }

    if (event.type === "result") {
      session.lastResponse = event.text;
    }
  }
});
```

---

## Thread → Session Persistence

### In-memory (MVP)

```typescript
const sessions = new Map<string, ThreadSession>();

interface ThreadSession {
  sessionId: string | null;
  worktreePath: string;
  status: "idle" | "busy";
  pendingMessages: Array<{ user: string; text: string; ts: string }>;
  lastActivity: number;
  skillSet: string; // which CLAUDE.md / MCP config to use
}
```

### Redis (production)

For a bot that survives restarts:

```typescript
// Store: thread:<threadId> → { sessionId, worktreePath, skillSet, lastActivity }
// TTL: 24h, extended on each message
await redis.hset(`thread:${threadId}`, {
  sessionId: session.sessionId,
  worktreePath: session.worktreePath,
  skillSet: session.skillSet,
  lastActivity: Date.now().toString(),
});
await redis.expire(`thread:${threadId}`, 86400);
```

Pending messages don't need persistence — if the bot restarts mid-execution, the Claude process dies with it. The session is still resumable; the user just re-sends.

---

## Cleanup & Lifecycle

### Stale thread cleanup

Cron job or background timer:

```typescript
async function cleanupStaleThreads() {
  for (const [threadId, session] of sessions.entries()) {
    if (Date.now() - session.lastActivity > STALE_TIMEOUT_MS) {
      // check for uncommitted changes in worktree
      const hasChanges = checkWorktreeChanges(session.worktreePath);

      if (hasChanges) {
        await postToSlack(
          threadId,
          "⚠️ This thread has uncommitted changes. Cleaning up in 1h unless you respond.",
        );
        // give grace period, then force cleanup
      } else {
        removeWorktree(threadId);
        sessions.delete(threadId);
      }
    }
  }
}
```

### Process cleanup

Always handle zombie processes:

```typescript
proc.on("error", (err) => {
  session.status = "idle";
  postToSlack(threadId, `❌ Claude errored: ${err.message}`);
});

// timeout guard — kill if Claude hangs
const timeout = setTimeout(() => {
  proc.kill("SIGINT");
  postToSlack(
    threadId,
    "⏱️ Timed out after 5 minutes. Try a more specific prompt.",
  );
}, 300_000);

proc.on("exit", () => clearTimeout(timeout));
```

---

## Constraints & Known Limitations

1. **Max subscription, not API.** The CLI uses Max auth. This means rate limits are whatever Anthropic enforces on Max, not the API's documented limits. If you hit throttling, there's no programmatic way to check remaining quota.

2. **Cold start per message.** Every `-p` invocation is a new process. Auth handshake + session load adds ~2-5 seconds per message. Acceptable for async Slack threads, not for real-time chat.

3. **Single-turn only.** Claude can't proactively send follow-up messages. It's always request → response. For "hey, one more thing" behavior, you'd need a hook or a second scheduled invocation.

4. **`--input-format stream-json` is undocumented.** The bidirectional streaming primitive exists but the protocol isn't specified. Don't build production systems on it yet.

5. **Worktree base branch.** `--worktree` always branches from `origin/HEAD`. If you need a different base (e.g., `staging`), use manual worktree creation or a `WorktreeCreate` hook.

6. **No cost visibility.** With Max subscription, there's no per-session cost tracking from the CLI. You can't budget per-thread.

---

## Open Questions

- [ ] What's the exact `stream-json` event schema? Need to test and document the event types we get back for session_id extraction and response parsing.
- [ ] Does `--resume` work reliably with `--worktree`? Or do we need to manage worktrees manually and pass `cwd` instead?
- [ ] Can multiple `claude -p --resume` processes target the same session concurrently, or does Claude lock the session file? (Matters for the buffer-drain race condition.)
- [ ] What happens when the Max subscription hits usage limits mid-process? Does the CLI error gracefully or hang?
- [ ] Should the bot support thread-level commands? E.g., `/claude-reset` to clear the session, `/claude-branch staging` to change the worktree base.
