import type { RunnerEvent } from "../runners/types.ts";

export interface OpenCodeStepStartEvent {
  type: "step_start";
  sessionID: string;
  [key: string]: unknown;
}

export interface OpenCodeTextEvent {
  type: "text";
  sessionID?: string;
  part: {
    type: "text";
    text: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface OpenCodeStepFinishEvent {
  type: "step_finish";
  sessionID?: string;
  part?: {
    tokens?: Record<string, unknown>;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

// Placeholder until real OpenCode tool fixtures are captured.
export interface OpenCodeToolEventPlaceholder {
  type: string;
  sessionID?: string;
  [key: string]: unknown;
}

export type OpenCodeEvent =
  | OpenCodeStepStartEvent
  | OpenCodeTextEvent
  | OpenCodeStepFinishEvent;

export interface OpenCodeStreamParser {
  feed(chunk: string): OpenCodeEvent[];
  flush(): OpenCodeEvent[];
}

export interface OpenCodeEventMapper {
  readonly sessionId: string | null;
  readonly response: string;
  map(event: OpenCodeEvent): RunnerEvent[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOpenCodeEvent(value: unknown): value is OpenCodeEvent {
  if (!isRecord(value) || typeof value.type !== "string") return false;

  if (value.type === "step_start") {
    return typeof value.sessionID === "string";
  }

  if (value.type === "text") {
    if (!isRecord(value.part)) return false;
    return value.part.type === "text" && typeof value.part.text === "string";
  }

  if (value.type === "step_finish") {
    return true;
  }

  return false;
}

function parseLine(line: string): OpenCodeEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isOpenCodeEvent(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function createOpenCodeStreamParser(): OpenCodeStreamParser {
  let buffer = "";

  function drain(consumePartial: boolean): OpenCodeEvent[] {
    const events: OpenCodeEvent[] = [];
    let newlineIdx = buffer.indexOf("\n");

    while (newlineIdx !== -1) {
      const event = parseLine(buffer.slice(0, newlineIdx));
      if (event) events.push(event);
      buffer = buffer.slice(newlineIdx + 1);
      newlineIdx = buffer.indexOf("\n");
    }

    if (consumePartial && buffer.trim()) {
      const event = parseLine(buffer);
      if (event) events.push(event);
      buffer = "";
    }

    return events;
  }

  return {
    feed(chunk: string): OpenCodeEvent[] {
      buffer += chunk;
      return drain(false);
    },
    flush(): OpenCodeEvent[] {
      return drain(true);
    },
  };
}

export function createOpenCodeEventMapper(): OpenCodeEventMapper {
  let sessionId: string | null = null;
  let response = "";

  function maybeInit(event: OpenCodeEvent): RunnerEvent[] {
    if (sessionId) return [];
    const nativeSessionId = typeof event.sessionID === "string" ? event.sessionID : null;
    if (!nativeSessionId) return [];

    sessionId = nativeSessionId;
    return [{ type: "init", provider: "opencode", sessionId: nativeSessionId }];
  }

  return {
    get sessionId(): string | null {
      return sessionId;
    },
    get response(): string {
      return response;
    },
    map(event: OpenCodeEvent): RunnerEvent[] {
      const events = maybeInit(event);

      if (event.type === "text") {
        response += event.part.text;
        events.push({
          type: "message",
          provider: "opencode",
          text: event.part.text,
        });
      } else if (event.type === "step_finish" && event.part?.tokens) {
        events.push({
          type: "done",
          provider: "opencode",
          usage: event.part.tokens,
        });
      }

      return events;
    },
  };
}
