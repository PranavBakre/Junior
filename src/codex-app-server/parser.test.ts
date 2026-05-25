import { describe, expect, it } from "bun:test";
import {
  createCodexAppServerEventMapper,
  createCodexAppServerStreamParser,
} from "./parser.ts";

describe("createCodexAppServerStreamParser", () => {
  it("parses app-server JSON-RPC notifications and buffers split lines", () => {
    const parser = createCodexAppServerStreamParser();

    expect(parser.feed('{"jsonrpc":"2.0","method":"thread/started","params":')).toEqual([]);
    expect(parser.feed('{"thread":{"id":"thr_1"}}}\n')).toEqual([
      {
        jsonrpc: "2.0",
        method: "thread/started",
        params: { thread: { id: "thr_1" } },
      },
    ]);
  });

  it("ignores JSON-RPC responses", () => {
    const parser = createCodexAppServerStreamParser();

    expect(parser.feed('{"jsonrpc":"2.0","id":1,"result":{}}\n')).toEqual([]);
  });
});

describe("createCodexAppServerEventMapper", () => {
  it("maps thread start, agent deltas, turn completion, and usage", () => {
    const mapper = createCodexAppServerEventMapper();
    const events = [
      {
        method: "thread/started",
        params: { thread: { id: "thr_1" } },
      },
      {
        method: "item/agentMessage/delta",
        params: { threadId: "thr_1", delta: "Hello" },
      },
      {
        method: "item/agentMessage/delta",
        params: { threadId: "thr_1", delta: " world" },
      },
      {
        method: "turn/completed",
        params: { threadId: "thr_1", usage: { input_tokens: 1, output_tokens: 2 } },
      },
    ].flatMap((event) => mapper.map(event));

    expect(events).toEqual([
      { type: "init", provider: "codex-app-server", sessionId: "thr_1" },
      { type: "message", provider: "codex-app-server", text: "Hello world" },
      {
        type: "done",
        provider: "codex-app-server",
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    ]);
    expect(mapper.response).toBe("Hello world");
  });

  it("maps completed agentMessage items as responses", () => {
    const mapper = createCodexAppServerEventMapper();
    const events = [
      {
        method: "item/completed",
        params: {
          threadId: "thr_1",
          turnId: "turn_1",
          item: { type: "agentMessage", text: "here." },
        },
      },
      {
        method: "turn/completed",
        params: { threadId: "thr_1" },
      },
    ].flatMap((event) => mapper.map(event));

    expect(events).toEqual([
      { type: "init", provider: "codex-app-server", sessionId: "thr_1" },
      { type: "message", provider: "codex-app-server", text: "here." },
      { type: "done", provider: "codex-app-server" },
    ]);
    expect(mapper.response).toBe("here.");
  });

  it("captures app-server error and warning diagnostics", () => {
    const mapper = createCodexAppServerEventMapper();
    const events = [
      {
        method: "warning",
        params: { threadId: "thr_1", message: "approaching limit" },
      },
      {
        method: "error",
        params: { threadId: "thr_1", error: { message: "tool failed", code: "tool_error" } },
      },
    ].flatMap((event) => mapper.map(event));

    expect(events).toEqual([
      { type: "init", provider: "codex-app-server", sessionId: "thr_1" },
    ]);
    expect(mapper.warning).toBe("Codex app-server warning: approaching limit");
    expect(mapper.error).toBe("Codex app-server error: tool failed (tool_error)");
  });

  it("maps known tool-like item types", () => {
    const mapper = createCodexAppServerEventMapper();
    const runnerEvents = [
      {
        method: "item/started",
        params: {
          threadId: "thr_1",
          turnId: "turn_1",
          item: {
            type: "commandExecution",
            command: "bun test",
            cwd: "/repo",
            status: "in_progress",
          },
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "thr_1",
          turnId: "turn_1",
          item: {
            type: "mcpToolCall",
            server: "slack-bot",
            tool: "slack_send_message",
            arguments: { text: "posted" },
            result: { ok: true },
          },
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "thr_1",
          turnId: "turn_1",
          item: {
            type: "collabToolCall",
            sender: "default",
            receiver: "reviewer",
            newThreadId: "thr_child",
          },
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "thr_1",
          turnId: "turn_1",
          item: { type: "webSearch", query: "Codex app-server" },
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "thr_1",
          turnId: "turn_1",
          item: { type: "fileChange", path: "src/file.ts", action: "modify" },
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "thr_1",
          turnId: "turn_1",
          item: { type: "imageView", path: "bug.png" },
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "thr_1",
          turnId: "turn_1",
          item: { type: "enteredReviewMode", reviewType: "auto" },
        },
      },
    ].flatMap((event) => mapper.map(event));

    expect(runnerEvents).toMatchObject([
      { type: "init", provider: "codex-app-server", sessionId: "thr_1" },
      {
        type: "tool",
        provider: "codex-app-server",
        name: "Bash",
        input: {
          codexItemType: "commandExecution",
          command: "bun test",
          cwd: "/repo",
        },
        status: "started",
      },
      {
        type: "tool",
        provider: "codex-app-server",
        name: "slack_send_message",
        input: {
          codexItemType: "mcpToolCall",
          server: "slack-bot",
          tool: "slack_send_message",
          arguments: { text: "posted" },
        },
        status: "completed",
      },
      {
        type: "tool",
        provider: "codex-app-server",
        name: "Task",
        input: {
          codexItemType: "collabToolCall",
          receiver: "reviewer",
          newThreadId: "thr_child",
        },
        status: "completed",
      },
      {
        type: "tool",
        provider: "codex-app-server",
        name: "WebSearch",
        input: { query: "Codex app-server" },
        status: "completed",
      },
      {
        type: "tool",
        provider: "codex-app-server",
        name: "Edit",
        input: { path: "src/file.ts", action: "modify" },
        status: "completed",
      },
      {
        type: "tool",
        provider: "codex-app-server",
        name: "Read",
        input: { path: "bug.png" },
        status: "completed",
      },
      {
        type: "tool",
        provider: "codex-app-server",
        name: "Review",
        input: { reviewType: "auto" },
        status: "completed",
      },
    ]);
  });

  it("ignores known telemetry notifications and non-tool item types", () => {
    const mapper = createCodexAppServerEventMapper();
    const runnerEvents = [
      {
        method: "remoteControl/status/changed",
        params: { status: "disconnected" },
      },
      {
        method: "account/rateLimits/updated",
        params: { rateLimits: [] },
      },
      {
        method: "turn/diff/updated",
        params: { threadId: "thr_1", turnId: "turn_1" },
      },
      {
        method: "item/reasoning/summaryTextDelta",
        params: { threadId: "thr_1", itemId: "item_1", delta: "summary" },
      },
      {
        method: "item/commandExecution/outputDelta",
        params: { threadId: "thr_1", itemId: "item_2", delta: "stdout" },
      },
      {
        method: "item/started",
        params: {
          threadId: "thr_1",
          turnId: "turn_1",
          item: { type: "reasoning", text: "thinking" },
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "thr_1",
          turnId: "turn_1",
          item: { type: "reasoning", text: "done thinking" },
        },
      },
      {
        method: "item/completed",
        params: {
          threadId: "thr_1",
          turnId: "turn_1",
          item: { type: "plan", text: "inspect then edit" },
        },
      },
    ].flatMap((event) => mapper.map(event));

    expect(runnerEvents).toEqual([
      { type: "init", provider: "codex-app-server", sessionId: "thr_1" },
    ]);
  });
});
