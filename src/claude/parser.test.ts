import { describe, it, expect } from "bun:test";
import { createStreamParser } from "./parser.ts";

describe("createStreamParser", () => {
  it("parses a complete JSON line into an event", () => {
    const parser = createStreamParser();
    const events = parser.feed(
      '{"type":"system","subtype":"init","session_id":"abc123"}\n',
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: "system",
      subtype: "init",
      session_id: "abc123",
    });
  });

  it("parses multiple lines in one chunk", () => {
    const parser = createStreamParser();
    const chunk =
      '{"type":"system","subtype":"init","session_id":"s1"}\n' +
      '{"type":"assistant","subtype":"text","text":"hello"}\n';
    const events = parser.feed(chunk);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("system");
    expect(events[1].type).toBe("assistant");
  });

  it("buffers partial line and returns on next feed", () => {
    const parser = createStreamParser();

    const events1 = parser.feed('{"type":"system","subtype":"init"');
    expect(events1).toHaveLength(0);

    const events2 = parser.feed(',"session_id":"s1"}\n');
    expect(events2).toHaveLength(1);
    expect(events2[0]).toEqual({
      type: "system",
      subtype: "init",
      session_id: "s1",
    });
  });

  it("handles JSON split across chunks", () => {
    const parser = createStreamParser();
    const full = '{"type":"result","subtype":"success","text":"done"}';
    const mid = Math.floor(full.length / 2);

    const events1 = parser.feed(full.slice(0, mid));
    expect(events1).toHaveLength(0);

    const events2 = parser.feed(full.slice(mid) + "\n");
    expect(events2).toHaveLength(1);
    expect(events2[0]).toEqual({
      type: "result",
      subtype: "success",
      text: "done",
    });
  });

  it("skips invalid JSON without crashing", () => {
    const parser = createStreamParser();
    const events = parser.feed("not valid json\n");
    expect(events).toHaveLength(0);
  });

  it("skips unrecognized event shape", () => {
    const parser = createStreamParser();
    const events = parser.feed('{"type":"unknown","foo":"bar"}\n');
    expect(events).toHaveLength(0);
  });

  it("ignores empty lines", () => {
    const parser = createStreamParser();
    const events = parser.feed(
      '\n\n{"type":"system","subtype":"init","session_id":"s1"}\n\n',
    );
    expect(events).toHaveLength(1);
  });

  it("correctly types init events", () => {
    const parser = createStreamParser();
    const events = parser.feed(
      '{"type":"system","subtype":"init","session_id":"sess-42"}\n',
    );
    expect(events).toHaveLength(1);
    const evt = events[0];
    expect(evt.type).toBe("system");
    if (evt.type === "system") {
      expect(evt.subtype).toBe("init");
      expect(evt.session_id).toBe("sess-42");
    }
  });

  it("correctly types tool_use events", () => {
    const parser = createStreamParser();
    const events = parser.feed(
      '{"type":"assistant","subtype":"tool_use","tool":"Bash","input":{"command":"ls"}}\n',
    );
    expect(events).toHaveLength(1);
    const evt = events[0];
    expect(evt.type).toBe("assistant");
    if (evt.type === "assistant" && evt.subtype === "tool_use") {
      expect(evt.tool).toBe("Bash");
      expect(evt.input).toEqual({ command: "ls" });
    }
  });

  it("correctly types result events", () => {
    const parser = createStreamParser();
    const events = parser.feed(
      '{"type":"result","subtype":"error","text":"something failed"}\n',
    );
    expect(events).toHaveLength(1);
    const evt = events[0];
    expect(evt.type).toBe("result");
    if (evt.type === "result") {
      expect(evt.subtype).toBe("error");
      expect(evt.text).toBe("something failed");
    }
  });

  it("correctly types text events", () => {
    const parser = createStreamParser();
    const events = parser.feed(
      '{"type":"assistant","subtype":"text","text":"Here is my response"}\n',
    );
    expect(events).toHaveLength(1);
    const evt = events[0];
    if (evt.type === "assistant" && evt.subtype === "text") {
      expect(evt.text).toBe("Here is my response");
    }
  });

  it("handles mixed valid and invalid lines", () => {
    const parser = createStreamParser();
    const chunk =
      '{"type":"system","subtype":"init","session_id":"s1"}\n' +
      "broken json here\n" +
      '{"type":"result","subtype":"success","text":"ok"}\n';
    const events = parser.feed(chunk);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("system");
    expect(events[1].type).toBe("result");
  });

  it("skips valid JSON that is not a recognized event", () => {
    const parser = createStreamParser();
    // Valid JSON but missing required fields for any known event type
    const events = parser.feed('{"type":"assistant","subtype":"tool_use"}\n');
    expect(events).toHaveLength(0);
  });

  it("skips null and non-object JSON", () => {
    const parser = createStreamParser();
    const events1 = parser.feed("null\n");
    expect(events1).toHaveLength(0);

    const events2 = parser.feed('"just a string"\n');
    expect(events2).toHaveLength(0);

    const events3 = parser.feed("42\n");
    expect(events3).toHaveLength(0);
  });
});
