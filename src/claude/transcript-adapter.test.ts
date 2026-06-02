import { describe, it, expect } from "bun:test";
import { adaptTranscriptLine } from "./transcript-adapter.ts";

describe("adaptTranscriptLine", () => {
  it("returns null for non-JSON lines", () => {
    expect(adaptTranscriptLine("not json")).toBeNull();
    expect(adaptTranscriptLine("")).toBeNull();
  });

  it("flags system.subtype=turn_duration as turnDone", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "turn_duration",
      durationMs: 1000,
      messageCount: 5,
      sessionId: "s1",
    });
    const out = adaptTranscriptLine(line);
    expect(out).not.toBeNull();
    expect(out!.turnDone).toBe(true);
    expect(out!.sessionId).toBe("s1");
    expect(out!.event).toBeNull();
  });

  it("does not flag stop_hook_summary as turnDone (it's redundant after turn_duration)", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "stop_hook_summary",
      sessionId: "s2",
    });
    const out = adaptTranscriptLine(line);
    expect(out).not.toBeNull();
    expect(out!.turnDone).toBe(false);
    expect(out!.sessionId).toBe("s2");
  });

  it("synthesizes a StreamEventInit from system.subtype=init", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      sessionId: "abc-def",
      cwd: "/tmp/example",
    });
    const out = adaptTranscriptLine(line);
    expect(out).not.toBeNull();
    expect(out!.event).toEqual({
      type: "system",
      subtype: "init",
      session_id: "abc-def",
      cwd: "/tmp/example",
    });
    expect(out!.turnDone).toBe(false);
  });

  it("translates assistant events with message.content into StreamEventAssistant", () => {
    const line = JSON.stringify({
      type: "assistant",
      sessionId: "s3",
      message: {
        role: "assistant",
        id: "msg_1",
        model: "claude-opus-4-7",
        content: [{ type: "text", text: "hello" }],
      },
    });
    const out = adaptTranscriptLine(line);
    expect(out).not.toBeNull();
    expect(out!.event?.type).toBe("assistant");
    if (out!.event?.type === "assistant") {
      expect(out!.event.message.content).toEqual([{ type: "text", text: "hello" }]);
      expect(out!.event.message.id).toBe("msg_1");
      expect(out!.event.message.model).toBe("claude-opus-4-7");
    }
  });

  it("drops metadata-only types (last-prompt, ai-title, pr-link, etc.)", () => {
    const lines = [
      JSON.stringify({ type: "last-prompt", sessionId: "s" }),
      JSON.stringify({ type: "permission-mode", sessionId: "s" }),
      JSON.stringify({ type: "ai-title", sessionId: "s" }),
      JSON.stringify({ type: "attachment", sessionId: "s" }),
      JSON.stringify({ type: "file-history-snapshot" }),
      JSON.stringify({ type: "pr-link", sessionId: "s" }),
      JSON.stringify({ type: "system", subtype: "bridge_status", sessionId: "s" }),
    ];
    for (const line of lines) {
      const out = adaptTranscriptLine(line);
      // sessionId may still be lifted but event must be null and turnDone false
      expect(out?.event ?? null).toBeNull();
      expect(out?.turnDone ?? false).toBe(false);
    }
  });

  it("preserves user echo events as type-only StreamEvent", () => {
    const line = JSON.stringify({
      type: "user",
      sessionId: "s",
      message: { role: "user", content: "hi" },
    });
    const out = adaptTranscriptLine(line);
    expect(out?.event).toEqual({ type: "user" });
  });
});
