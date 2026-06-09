import { describe, it, expect } from "bun:test";
import {
  extractRunnerMessageText,
  formatRunnerToolStatuses,
  formatToolStatuses,
  isDuplicateSlackToolResponse,
  prepareSlackResponseWithActions,
  sanitizeErrorForSlack,
  splitResponse,
} from "./formatting.ts";
import type { StreamEventAssistant } from "../claude/types.ts";
import type { RunnerEvent, RunnerEventTool } from "../runners/types.ts";

function makeAssistantEvent(
  tools: Array<{ name?: string; input?: Record<string, unknown> }>,
): StreamEventAssistant {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: tools.map((t) => ({
        type: "tool_use" as const,
        name: t.name,
        input: t.input,
      })),
    },
  };
}

function makeToolEvent(
  overrides: Partial<RunnerEventTool> = {},
): RunnerEventTool {
  return {
    type: "tool",
    provider: "claude",
    name: "Unknown",
    input: {},
    ...overrides,
  };
}

describe("formatRunnerToolStatuses", () => {
  it("formats Bash with command", () => {
    const result = formatRunnerToolStatuses(makeToolEvent({ name: "Bash", input: { command: "git diff" } }));
    expect(result).toEqual(["Running: `git diff`"]);
  });

  it("truncates Bash command longer than 80 chars", () => {
    const longCmd = "a".repeat(100);
    const result = formatRunnerToolStatuses(makeToolEvent({ name: "Bash", input: { command: longCmd } }));
    expect(result[0]).toBe(`Running: \`${"a".repeat(77)}...\``);
  });

  it("does not truncate Bash command of exactly 80 chars", () => {
    const cmd = "b".repeat(80);
    const result = formatRunnerToolStatuses(makeToolEvent({ name: "Bash", input: { command: cmd } }));
    expect(result[0]).toBe(`Running: \`${cmd}\``);
  });

  it("formats Read with file_path", () => {
    const result = formatRunnerToolStatuses(makeToolEvent({ name: "Read", input: { file_path: "src/auth.ts" } }));
    expect(result).toEqual(["Reading `src/auth.ts`"]);
  });

  it("formats Edit with file_path", () => {
    const result = formatRunnerToolStatuses(makeToolEvent({ name: "Edit", input: { file_path: "src/index.ts" } }));
    expect(result).toEqual(["Editing `src/index.ts`"]);
  });

  it("formats Write with file_path", () => {
    const result = formatRunnerToolStatuses(makeToolEvent({ name: "Write", input: { file_path: "src/new.ts" } }));
    expect(result).toEqual(["Editing `src/new.ts`"]);
  });

  it("formats Grep with pattern", () => {
    const result = formatRunnerToolStatuses(makeToolEvent({ name: "Grep", input: { pattern: "TODO" } }));
    expect(result).toEqual(["Searching for `TODO`"]);
  });

  it("formats Glob with pattern", () => {
    const result = formatRunnerToolStatuses(makeToolEvent({ name: "Glob", input: { pattern: "**/*.ts" } }));
    expect(result).toEqual(["Searching for `**/*.ts`"]);
  });

  it("formats unknown tool with tool name", () => {
    const result = formatRunnerToolStatuses(makeToolEvent({ name: "WebSearch" }));
    expect(result).toEqual(["Using WebSearch"]);
  });

  it("formats Task with subagent_type", () => {
    const result = formatRunnerToolStatuses(makeToolEvent({
      name: "Task",
      input: { subagent_type: "nr-research" },
    }));
    expect(result).toEqual(["Calling nr-research"]);
  });

  it("rolls up parallel Task calls", () => {
    const result = formatRunnerToolStatuses([
      makeToolEvent({ name: "Task", input: { subagent_type: "nr-research" } }),
      makeToolEvent({ name: "Task", input: { subagent_type: "sentry-fetch" } }),
      makeToolEvent({ name: "Task", input: { subagent_type: "vercel-status" } }),
    ]);
    expect(result).toEqual([
      "Calling nr-research, sentry-fetch, vercel-status (3 in progress)",
    ]);
  });

  it("handles missing input", () => {
    const result = formatRunnerToolStatuses(makeToolEvent({ name: "Bash" }));
    expect(result).toEqual(["Running: ``"]);
  });

  it("handles blank name", () => {
    const result = formatRunnerToolStatuses(makeToolEvent({ name: "" }));
    expect(result).toEqual(["Using Unknown"]);
  });

  it("returns empty for non-tool events", () => {
    const event: RunnerEvent = { type: "message", provider: "claude", text: "hello" };
    expect(formatRunnerToolStatuses(event)).toEqual([]);
  });

  it("handles multiple tool events", () => {
    const result = formatRunnerToolStatuses([
      makeToolEvent({ name: "Read", input: { file_path: "a.ts" } }),
      makeToolEvent({ name: "Read", input: { file_path: "b.ts" } }),
    ]);
    expect(result).toHaveLength(2);
  });
});

describe("formatToolStatuses", () => {
  it("preserves Claude assistant-event status labels", () => {
    const result = formatToolStatuses(makeAssistantEvent([
      { name: "Bash", input: { command: "git diff" } },
      { name: "Read", input: { file_path: "src/auth.ts" } },
    ]));
    expect(result).toEqual(["Running: `git diff`", "Reading `src/auth.ts`"]);
  });

  it("preserves Claude text-only filtering", () => {
    const event: StreamEventAssistant = {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
    };
    expect(formatToolStatuses(event)).toEqual([]);
  });

  it("preserves Claude missing name fallback", () => {
    const result = formatToolStatuses(makeAssistantEvent([{}]));
    expect(result).toEqual(["Using Unknown"]);
  });
});

describe("extractRunnerMessageText", () => {
  it("extracts normalized message text", () => {
    expect(extractRunnerMessageText({
      type: "message",
      provider: "claude",
      text: "hello",
    })).toBe("hello");
  });

  it("returns null for empty message text", () => {
    expect(extractRunnerMessageText({
      type: "message",
      provider: "claude",
      text: "",
    })).toBeNull();
  });

  it("returns null for non-message events", () => {
    expect(extractRunnerMessageText(makeToolEvent({ name: "Bash" }))).toBeNull();
  });
});

describe("prepareSlackResponseWithActions", () => {
  it("strips junior action specs and returns validated actions", () => {
    const result = prepareSlackResponseWithActions(`review: changes-requested
by review

<junior-actions>
[
  {
    "id": "review:rereview",
    "label": "Re-review",
    "style": "primary",
    "type": "dispatch_agent",
    "agent": "review",
    "prompt": "read history and re-review"
  },
  {
    "id": "thread:cleanup-worktree",
    "label": "Cleanup worktree",
    "type": "cleanup_worktree"
  }
]
</junior-actions>`);

    expect(result).toEqual({
      text: "review: changes-requested\nby review",
      actions: [
        {
          id: "review:rereview",
          label: "Re-review",
          style: "primary",
          type: "dispatch_agent",
          agent: "review",
          prompt: "read history and re-review",
        },
        {
          id: "thread:cleanup-worktree",
          label: "Cleanup worktree",
          type: "cleanup_worktree",
        },
      ],
    });
  });

  it("drops malformed action specs without dropping visible text", () => {
    const result = prepareSlackResponseWithActions(`ok
<junior-actions>
not json
</junior-actions>`);

    expect(result).toEqual({ text: "ok", actions: [] });
  });
});

describe("isDuplicateSlackToolResponse", () => {
  it("detects final text already posted through slack_send_message", () => {
    const events: RunnerEvent[] = [
      makeToolEvent({
        name: "mcp__slack-bot__slack_send_message",
        input: { text: "!review check PR 123" },
      }),
    ];

    expect(isDuplicateSlackToolResponse("!review check PR 123", events)).toBe(true);
  });

  it("treats a trailing sentinel as duplicate of posted content", () => {
    const events: RunnerEvent[] = [
      makeToolEvent({
        name: "slack_send_message",
        input: { text: "posted already" },
      }),
    ];

    expect(isDuplicateSlackToolResponse("posted already\nNO_SLACK_MESSAGE", events)).toBe(true);
  });

  it("detects OpenCode MCP names that use single separators", () => {
    const events: RunnerEvent[] = [
      makeToolEvent({
        name: "slack-bot_slack_send_message",
        input: { text: "!review check PR 123" },
      }),
    ];

    expect(isDuplicateSlackToolResponse("!review check PR 123", events)).toBe(true);
  });

  it("detects generic OpenCode MCP events with nested tool name and text", () => {
    const events: RunnerEvent[] = [
      makeToolEvent({
        name: "mcp",
        input: {
          server: "slack-bot",
          tool: "slack_send_message",
          arguments: { text: "!review check PR 123" },
        },
      }),
    ];

    expect(isDuplicateSlackToolResponse("!review check PR 123", events)).toBe(true);
  });

  it("detects Codex app-server mcpToolCall events", () => {
    const events: RunnerEvent[] = [
      makeToolEvent({
        provider: "codex-app-server",
        name: "slack_send_message",
        input: {
          codexItemType: "mcpToolCall",
          server: "slack-bot",
          tool: "slack_send_message",
          arguments: { text: "posted from Codex" },
        },
      }),
    ];

    expect(isDuplicateSlackToolResponse("posted from Codex", events)).toBe(true);
  });

  it("does not suppress different follow-up text", () => {
    const events: RunnerEvent[] = [
      makeToolEvent({
        name: "mcp__slack-bot__slack_send_message",
        input: { text: "posted already" },
      }),
    ];

    expect(isDuplicateSlackToolResponse("additional context", events)).toBe(false);
  });
});

describe("sanitizeErrorForSlack", () => {
  it("keeps short normal errors", () => {
    expect(sanitizeErrorForSlack("Claude crashed")).toBe("Claude crashed");
  });

  it("strips ANSI sequences from safe errors", () => {
    expect(sanitizeErrorForSlack("\u001b[91m\u001b[1mError:\u001b[0m nope")).toBe(
      "Error: nope",
    );
  });

  it("withholds tool errors that include injected prompt/context", () => {
    const leaked = `\u001b[91mError:\u001b[0m File not found: <identity>\n# SOUL.md — Junior\nYour Slack user ID is U0ABKQ4V065`;

    expect(sanitizeErrorForSlack(leaked)).toBe(
      "runner failed. Raw error withheld because it contained injected prompt/context; check server logs.",
    );
  });

  it("withholds short errors that include any prompt wrapper tag", () => {
    expect(sanitizeErrorForSlack("bad input: <workspace>repo paths</workspace>")).toBe(
      "runner failed. Raw error withheld because it contained injected prompt/context; check server logs.",
    );
    expect(sanitizeErrorForSlack("bad input: <junior-core>rules</junior-core>")).toBe(
      "runner failed. Raw error withheld because it contained injected prompt/context; check server logs.",
    );
  });

  it("withholds very long errors instead of posting raw stderr", () => {
    expect(sanitizeErrorForSlack("x".repeat(501))).toBe(
      "runner failed. Raw error was too long to post safely; check server logs.",
    );
  });

  it("uses a generic message for blank errors", () => {
    expect(sanitizeErrorForSlack("  ")).toBe(
      "runner failed. Check server logs for details.",
    );
  });
});

describe("splitResponse", () => {
  it("returns single chunk for short text", () => {
    const result = splitResponse("Hello world", 100);
    expect(result).toEqual(["Hello world"]);
  });

  it("returns empty array for empty string", () => {
    expect(splitResponse("")).toEqual([]);
  });

  it("splits at paragraph boundary (double newline)", () => {
    const text = "First paragraph.\n\nSecond paragraph.";
    const result = splitResponse(text, 25);
    expect(result).toEqual(["First paragraph.", "Second paragraph."]);
  });

  it("keeps code blocks intact", () => {
    const code = "x".repeat(20);
    const text = `Before\n\n\`\`\`\n${code}\n\`\`\`\n\nAfter`;
    const result = splitResponse(text, 30);
    for (const chunk of result) {
      const backtickCount = (chunk.match(/```/g) || []).length;
      expect(backtickCount % 2).toBe(0);
    }
  });

  it("splits at maxLength as last resort", () => {
    const text = "x".repeat(200);
    const result = splitResponse(text, 50);
    expect(result).toHaveLength(4);
  });

  it("uses default maxLength of 4000", () => {
    const text = "a".repeat(4000);
    const result = splitResponse(text);
    expect(result).toEqual([text]);
  });

  it("returns text that exceeds default maxLength in multiple chunks", () => {
    const text = "a".repeat(8001);
    const result = splitResponse(text);
    expect(result.length).toBeGreaterThan(1);
    expect(result.join("")).toBe(text);
  });

  it("prefers paragraph splits over single newline splits", () => {
    const text = "Line one\nLine two\n\nLine three\nLine four";
    const result = splitResponse(text, 30);
    expect(result[0]).toBe("Line one\nLine two");
    expect(result[1]).toBe("Line three\nLine four");
  });

  it("splits at single newline when no paragraph break is available", () => {
    const text = "Line one\nLine two\nLine three\nLine four";
    const result = splitResponse(text, 20);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(20);
    }
  });
});
