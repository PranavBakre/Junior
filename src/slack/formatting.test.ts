import { describe, it, expect } from "bun:test";
import { formatToolStatus, splitResponse } from "./formatting.ts";
import type { StreamEventToolUse } from "../claude/types.ts";

function toolEvent(
  tool: string,
  input?: Record<string, unknown>,
): StreamEventToolUse {
  return { type: "assistant", subtype: "tool_use", tool, input };
}

describe("formatToolStatus", () => {
  it("formats Bash with command", () => {
    const result = formatToolStatus(toolEvent("Bash", { command: "git diff" }));
    expect(result).toBe("Running: `git diff`");
  });

  it("truncates Bash command longer than 80 chars", () => {
    const longCmd = "a".repeat(100);
    const result = formatToolStatus(toolEvent("Bash", { command: longCmd }));
    expect(result).toBe(`Running: \`${"a".repeat(77)}...\``);
    // Verify the inner text (without "Running: `" and "`") is exactly 80 chars
    const inner = result.slice("Running: `".length, -1);
    expect(inner).toHaveLength(80);
  });

  it("does not truncate Bash command of exactly 80 chars", () => {
    const cmd = "b".repeat(80);
    const result = formatToolStatus(toolEvent("Bash", { command: cmd }));
    expect(result).toBe(`Running: \`${cmd}\``);
  });

  it("formats Read with file_path", () => {
    const result = formatToolStatus(
      toolEvent("Read", { file_path: "src/auth.ts" }),
    );
    expect(result).toBe("Reading `src/auth.ts`");
  });

  it("formats Edit with file_path", () => {
    const result = formatToolStatus(
      toolEvent("Edit", { file_path: "src/index.ts" }),
    );
    expect(result).toBe("Editing `src/index.ts`");
  });

  it("formats Write with file_path", () => {
    const result = formatToolStatus(
      toolEvent("Write", { file_path: "src/new.ts" }),
    );
    expect(result).toBe("Editing `src/new.ts`");
  });

  it("formats Grep with pattern", () => {
    const result = formatToolStatus(
      toolEvent("Grep", { pattern: "TODO" }),
    );
    expect(result).toBe("Searching for `TODO`");
  });

  it("formats Glob with pattern", () => {
    const result = formatToolStatus(
      toolEvent("Glob", { pattern: "**/*.ts" }),
    );
    expect(result).toBe("Searching for `**/*.ts`");
  });

  it("formats unknown tool with tool name", () => {
    const result = formatToolStatus(toolEvent("WebSearch"));
    expect(result).toBe("Using WebSearch");
  });

  it("handles Bash with missing input", () => {
    const result = formatToolStatus(toolEvent("Bash"));
    expect(result).toBe("Running: ``");
  });

  it("handles Read with missing file_path", () => {
    const result = formatToolStatus(toolEvent("Read"));
    expect(result).toBe("Reading ``");
  });

  it("handles Bash with non-string command", () => {
    const result = formatToolStatus(
      toolEvent("Bash", { command: 123 as unknown as string }),
    );
    expect(result).toBe("Running: ``");
  });

  it("handles Grep with missing pattern", () => {
    const result = formatToolStatus(toolEvent("Grep", {}));
    expect(result).toBe("Searching for ``");
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
    // maxLength is small enough that the code block spans beyond it,
    // but the function should try to keep ``` blocks together
    const result = splitResponse(text, 30);
    // The code block should not be split in the middle
    for (const chunk of result) {
      const backtickCount = (chunk.match(/```/g) || []).length;
      // Each chunk should have even number of ``` (0 or 2) — meaning code blocks are closed
      expect(backtickCount % 2).toBe(0);
    }
  });

  it("splits at maxLength as last resort", () => {
    // A string with no newlines at all — forces the last-resort split
    const text = "x".repeat(200);
    const result = splitResponse(text, 50);
    expect(result).toHaveLength(4);
    expect(result[0]).toBe("x".repeat(50));
    expect(result[1]).toBe("x".repeat(50));
    expect(result[2]).toBe("x".repeat(50));
    expect(result[3]).toBe("x".repeat(50));
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
    // maxLength enough to include up to the paragraph break
    const result = splitResponse(text, 30);
    expect(result[0]).toBe("Line one\nLine two");
    expect(result[1]).toBe("Line three\nLine four");
  });

  it("splits at single newline when no paragraph break is available", () => {
    const text = "Line one\nLine two\nLine three\nLine four";
    const result = splitResponse(text, 20);
    // Should split at newline boundaries
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(20);
    }
  });
});
