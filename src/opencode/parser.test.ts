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

  it("flushes a final valid line without trailing newline", () => {
    const parser = createOpenCodeStreamParser();

    expect(parser.feed('{"type":"step_start","sessionID":"ses_1"}')).toEqual([]);
    expect(parser.flush()).toMatchObject([
      { type: "step_start", sessionID: "ses_1" },
    ]);
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
});
