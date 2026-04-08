import type { StreamEvent } from "./types.ts";

export interface StreamParser {
  feed(chunk: string): StreamEvent[];
}

function isStreamEvent(value: unknown): value is StreamEvent {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;

  if (obj.type === "system" && obj.subtype === "init" && typeof obj.session_id === "string") {
    return true;
  }
  if (obj.type === "assistant" && obj.subtype === "tool_use" && typeof obj.tool === "string") {
    return true;
  }
  if (obj.type === "assistant" && obj.subtype === "text" && typeof obj.text === "string") {
    return true;
  }
  if (obj.type === "result" && (obj.subtype === "success" || obj.subtype === "error") && typeof obj.text === "string") {
    return true;
  }

  return false;
}

export function createStreamParser(): StreamParser {
  let buffer = "";

  return {
    feed(chunk: string): StreamEvent[] {
      buffer += chunk;
      const events: StreamEvent[] = [];

      let newlineIdx = buffer.indexOf("\n");
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);

        if (line.length === 0) {
          newlineIdx = buffer.indexOf("\n");
          continue;
        }

        try {
          const parsed: unknown = JSON.parse(line);
          if (isStreamEvent(parsed)) {
            events.push(parsed);
          } else {
            console.warn("[parser] Unrecognized event shape, skipping:", line.slice(0, 200));
          }
        } catch {
          console.warn("[parser] Failed to parse JSON line, skipping:", line.slice(0, 200));
        }

        newlineIdx = buffer.indexOf("\n");
      }

      return events;
    },
  };
}
