import type { StreamEvent } from "./types.ts";

export interface StreamParser {
  feed(chunk: string): StreamEvent[];
}

function isStreamEvent(value: unknown): value is StreamEvent {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;

  // system init
  if (obj.type === "system" && obj.subtype === "init" && typeof obj.session_id === "string") {
    return true;
  }

  // assistant message with content blocks
  if (obj.type === "assistant" && typeof obj.message === "object" && obj.message !== null) {
    const msg = obj.message as Record<string, unknown>;
    if (Array.isArray(msg.content)) {
      return true;
    }
  }

  // result
  if (obj.type === "result") {
    return true;
  }

  // user turn echo
  if (obj.type === "user") {
    return true;
  }

  // rate limit
  if (obj.type === "rate_limit_event") {
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
            events.push(parsed as StreamEvent);
          }
          // Silently skip unrecognized events — there may be new event types
        } catch {
          // Skip malformed lines
        }

        newlineIdx = buffer.indexOf("\n");
      }

      return events;
    },
  };
}
