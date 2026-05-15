import type { RunnerEvent } from "../runners/types.ts";
import { log } from "../logger.ts";

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

// Known OpenCode event types the parser currently maps. Anything else (most
// importantly tool/command events — those fixtures haven't been captured yet)
// gets logged at INFO so the gap is visible at runtime instead of a silent
// drop that looks indistinguishable from "no tool was used." Schema
// mismatches on known types log at WARN — those are real protocol breaks.
const KNOWN_EVENT_TYPES = new Set(["step_start", "text", "step_finish"]);

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

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    // Real protocol breaks present identically to forward-compat noise
    // (both produce null). Log once per malformed line so a breaking
    // upstream change isn't invisible.
    log.warn(
      "opencode-parser",
      `Dropped malformed JSON line (${(err as Error).message}): ${trimmed.slice(0, 200)}`,
    );
    return null;
  }

  if (isOpenCodeEvent(parsed)) return parsed;

  // Recognized event-type string but failed schema validation: most likely
  // OpenCode changed the shape under us. Surface it.
  if (isRecord(parsed) && typeof parsed.type === "string") {
    if (KNOWN_EVENT_TYPES.has(parsed.type)) {
      log.warn(
        "opencode-parser",
        `Known event type "${parsed.type}" failed schema validation: ${trimmed.slice(0, 200)}`,
      );
    } else {
      // Unknown event type — most likely a tool/command event that we
      // haven't mapped yet. Log so operators can capture a fixture.
      log.info(
        "opencode-parser",
        `Unmapped event type "${parsed.type}" (tool events are deferred): ${trimmed.slice(0, 200)}`,
      );
    }
  }

  return null;
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
