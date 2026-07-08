import { describe, expect, it } from "bun:test";
import {
  createOpenCodeEventMapper,
  createOpenCodeStreamParser,
} from "./parser.ts";

describe("createOpenCodeStreamParser", () => {
  it("parses observed OpenCode JSONL events", () => {
    const parser = createOpenCodeStreamParser();
    const events = parser.feed(
      '{"type":"step_start","sessionID":"ses_123"}\n' +
        '{"type":"text","sessionID":"ses_123","part":{"type":"text","text":"\\n\\nOK"}}\n' +
        '{"type":"step_finish","sessionID":"ses_123","part":{"tokens":{"input":50,"output":16}}}\n',
    );

    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ type: "step_start", sessionID: "ses_123" });
    expect(events[1]).toMatchObject({
      type: "text",
      part: { type: "text", text: "\n\nOK" },
    });
    expect(events[2]).toMatchObject({
      type: "step_finish",
      part: { tokens: { input: 50, output: 16 } },
    });
  });

  it("buffers split lines across chunks", () => {
    const parser = createOpenCodeStreamParser();

    expect(parser.feed('{"type":"text","sessionID":"ses_1","part":')).toEqual([]);
    expect(
      parser.feed('{"type":"text","text":"hello"}}\n'),
    ).toMatchObject([
      {
        type: "text",
        sessionID: "ses_1",
        part: { type: "text", text: "hello" },
      },
    ]);
  });

  it("skips malformed and unknown lines", () => {
    const parser = createOpenCodeStreamParser();
    const events = parser.feed(
      "not json\n" +
        '{"type":"unknown","sessionID":"ses_1"}\n' +
        '{"type":"step_start","sessionID":"ses_1"}\n',
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "step_start", sessionID: "ses_1" });
  });

  it("parses observed OpenCode tool_use events", () => {
    const parser = createOpenCodeStreamParser();
    const events = parser.feed(
      '{"type":"tool_use","sessionID":"ses_1","part":{"type":"tool","tool":"bash","callID":"call_1","state":{"status":"completed","input":{"command":"bun test"}}}}\n',
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "tool_use",
      sessionID: "ses_1",
      part: {
        type: "tool",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "bun test" },
        },
      },
    });
  });

  it("parses current OpenCode part-stream events", () => {
    const parser = createOpenCodeStreamParser();
    const events = parser.feed(
      '{"type":"step-start"}\n' +
        '{"type":"tool","tool":"bash","state":{"status":"completed","input":{"command":"git status"}}}\n' +
        '{"type":"text","text":"final answer"}\n' +
        '{"type":"step-finish","tokens":{"input":10,"output":2}}\n',
    );

    expect(events).toMatchObject([
      { type: "step-start" },
      {
        type: "tool",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "git status" },
        },
      },
      { type: "text", text: "final answer" },
      { type: "step-finish", tokens: { input: 10, output: 2 } },
    ]);
  });

  it("flushes a final valid line without trailing newline", () => {
    const parser = createOpenCodeStreamParser();

    expect(parser.feed('{"type":"step_start","sessionID":"ses_1"}')).toEqual([]);
    expect(parser.flush()).toMatchObject([
      { type: "step_start", sessionID: "ses_1" },
    ]);
  });

  it("recognizes native OpenCode error events instead of dropping them", () => {
    const parser = createOpenCodeStreamParser();
    const events = parser.feed(
      '{"type":"error","timestamp":123,"sessionID":"ses_err","error":{"name":"UnknownError","data":{"message":"Unexpected server error. Check server logs for details.","ref":"abc123"}}}\n',
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "error",
      sessionID: "ses_err",
      error: {
        name: "UnknownError",
        data: {
          message: "Unexpected server error. Check server logs for details.",
          ref: "abc123",
        },
      },
    });
  });
});

describe("createOpenCodeEventMapper", () => {
  it("maps first sessionID to init, coalesced message, and done", () => {
    const parser = createOpenCodeStreamParser();
    const mapper = createOpenCodeEventMapper();
    const nativeEvents = parser.feed(
      '{"type":"step_start","sessionID":"ses_123"}\n' +
        '{"type":"text","sessionID":"ses_123","part":{"type":"text","text":"Hi"}}\n' +
        '{"type":"text","sessionID":"ses_123","part":{"type":"text","text":" there"}}\n' +
        '{"type":"step_finish","sessionID":"ses_123","part":{"tokens":{"input":2,"output":3}}}\n',
    );
    const runnerEvents = nativeEvents.flatMap((event) => mapper.map(event));

    expect(runnerEvents).toEqual([
      { type: "init", provider: "opencode", sessionId: "ses_123" },
      { type: "message", provider: "opencode", text: "Hi there" },
      {
        type: "done",
        provider: "opencode",
        usage: { input: 2, output: 3 },
      },
    ]);
    expect(mapper.sessionId).toBe("ses_123");
    expect(mapper.response).toBe("Hi there");
  });

  it("uses the latest completed text step as the final response", () => {
    const parser = createOpenCodeStreamParser();
    const mapper = createOpenCodeEventMapper();
    const nativeEvents = parser.feed(
      '{"type":"step_start","sessionID":"ses_steps"}\n' +
        '{"type":"text","sessionID":"ses_steps","part":{"type":"text","text":"Let me inspect the diff first."}}\n' +
        '{"type":"step_finish","sessionID":"ses_steps"}\n' +
        '{"type":"step_start","sessionID":"ses_steps"}\n' +
        '{"type":"text","sessionID":"ses_steps","part":{"type":"text","text":"review: approved — clean to ship"}}\n' +
        '{"type":"step_finish","sessionID":"ses_steps"}\n',
    );

    const runnerEvents = nativeEvents.flatMap((event) => mapper.map(event));

    expect(runnerEvents).toEqual([
      { type: "init", provider: "opencode", sessionId: "ses_steps" },
      {
        type: "message",
        provider: "opencode",
        text: "Let me inspect the diff first.",
      },
      { type: "done", provider: "opencode" },
      {
        type: "message",
        provider: "opencode",
        text: "review: approved — clean to ship",
      },
      { type: "done", provider: "opencode" },
    ]);
    expect(mapper.response).toBe("review: approved — clean to ship");
  });

  it("can initialize from the first text event carrying sessionID", () => {
    const parser = createOpenCodeStreamParser();
    const mapper = createOpenCodeEventMapper();
    const [event] = parser.feed(
      '{"type":"text","sessionID":"ses_text","part":{"type":"text","text":"chunk"}}\n',
    );

    expect(mapper.map(event)).toEqual([
      { type: "init", provider: "opencode", sessionId: "ses_text" },
    ]);
  });

  it("emits done even when step_finish has no usage", () => {
    const parser = createOpenCodeStreamParser();
    const mapper = createOpenCodeEventMapper();
    const nativeEvents = parser.feed(
      '{"type":"text","sessionID":"ses_done","part":{"type":"text","text":"OK"}}\n' +
        '{"type":"step_finish","sessionID":"ses_done"}\n',
    );

    expect(nativeEvents.flatMap((event) => mapper.map(event))).toEqual([
      { type: "init", provider: "opencode", sessionId: "ses_done" },
      { type: "message", provider: "opencode", text: "OK" },
      { type: "done", provider: "opencode" },
    ]);
  });

  it("maps OpenCode tool_use events to runner tool events", () => {
    const parser = createOpenCodeStreamParser();
    const mapper = createOpenCodeEventMapper();
    const nativeEvents = parser.feed(
      '{"type":"step_start","sessionID":"ses_tool"}\n' +
        '{"type":"tool_use","sessionID":"ses_tool","part":{"type":"tool","tool":"read","callID":"call_1","state":{"status":"completed","input":{"file_path":"src/opencode/parser.ts"}}}}\n',
    );

    expect(nativeEvents.flatMap((event) => mapper.map(event))).toEqual([
      { type: "init", provider: "opencode", sessionId: "ses_tool" },
      {
        type: "tool",
        provider: "opencode",
        name: "Read",
        input: { file_path: "src/opencode/parser.ts" },
        status: "completed",
      },
    ]);
  });

  it("maps current OpenCode part-stream text as the final response", () => {
    const parser = createOpenCodeStreamParser();
    const mapper = createOpenCodeEventMapper();
    const nativeEvents = parser.feed(
      '{"type":"step-start"}\n' +
        '{"type":"tool","tool":"bash","state":{"status":"completed","input":{"command":"gh pr list"}}}\n' +
        '{"type":"text","text":"*Worklog — last 24h*\\n\\n- shipped payout migration"}\n' +
        '{"type":"step-finish","tokens":{"input":100,"output":20}}\n',
    );

    expect(nativeEvents.flatMap((event) => mapper.map(event))).toEqual([
      {
        type: "tool",
        provider: "opencode",
        name: "Bash",
        input: { command: "gh pr list" },
        status: "completed",
      },
      {
        type: "message",
        provider: "opencode",
        text: "*Worklog — last 24h*\n\n- shipped payout migration",
      },
      {
        type: "done",
        provider: "opencode",
        usage: { input: 100, output: 20 },
      },
    ]);
    expect(mapper.response).toBe("*Worklog — last 24h*\n\n- shipped payout migration");
  });

  it("captures the native error message (incl. ref) on mapper.error", () => {
    const parser = createOpenCodeStreamParser();
    const mapper = createOpenCodeEventMapper();
    const nativeEvents = parser.feed(
      '{"type":"error","timestamp":123,"sessionID":"ses_err","error":{"name":"UnknownError","data":{"message":"Unexpected server error. Check server logs for details.","ref":"abc123"}}}\n',
    );

    const runnerEvents = nativeEvents.flatMap((event) => mapper.map(event));

    // The error event still carries a sessionID, so init is emitted; no
    // error-shaped RunnerEvent exists, so nothing else is emitted.
    expect(runnerEvents).toEqual([
      { type: "init", provider: "opencode", sessionId: "ses_err" },
    ]);
    expect(mapper.error).toBe(
      "UnknownError: Unexpected server error. Check server logs for details. (ref: abc123)",
    );
  });

  it("composes the error message without a ref when none is present", () => {
    const parser = createOpenCodeStreamParser();
    const mapper = createOpenCodeEventMapper();
    const nativeEvents = parser.feed(
      '{"type":"error","error":{"name":"ProviderError","data":{"message":"model not found"}}}\n',
    );

    nativeEvents.forEach((event) => mapper.map(event));

    expect(mapper.error).toBe("ProviderError: model not found");
  });

  it("has a null error until an error event is mapped", () => {
    const mapper = createOpenCodeEventMapper();
    expect(mapper.error).toBeNull();
  });
});
