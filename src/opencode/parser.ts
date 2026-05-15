import type { RunnerEvent, RunnerEventTool } from "../runners/types.ts";
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

export interface OpenCodeToolUseEvent {
  type: "tool_use";
  sessionID?: string;
  part: {
    type: "tool";
    tool: string;
    callID?: string;
    state?: {
      status?: string;
      input?: unknown;
      [key: string]: unknown;
    };
    input?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export type OpenCodeEvent =
  | OpenCodeStepStartEvent
  | OpenCodeTextEvent
  | OpenCodeStepFinishEvent
  | OpenCodeToolUseEvent;

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

// Known OpenCode event types the parser currently maps. Anything else gets
// logged at INFO so the gap is visible at runtime instead of a silent drop.
// Schema mismatches on known types log at WARN — those are real protocol breaks.
const KNOWN_EVENT_TYPES = new Set(["step_start", "text", "step_finish", "tool_use"]);

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

  if (value.type === "tool_use") {
    if (!isRecord(value.part)) return false;
    return value.part.type === "tool" && typeof value.part.tool === "string";
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
      // Unknown event type. Log so operators can capture a fixture.
      log.info(
        "opencode-parser",
        `Unmapped event type "${parsed.type}": ${trimmed.slice(0, 200)}`,
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
  let pendingText = "";

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
        pendingText += event.part.text;
      } else if (event.type === "tool_use") {
        events.push(mapOpenCodeToolUse(event));
      } else if (event.type === "step_finish") {
        if (pendingText) {
          events.push({
            type: "message",
            provider: "opencode",
            text: pendingText,
          });
          pendingText = "";
        }
        const done: RunnerEvent = {
          type: "done",
          provider: "opencode",
        };
        if (event.part?.tokens) {
          done.usage = event.part.tokens;
        }
        events.push(done);
      }

      return events;
    },
  };
}

function mapOpenCodeToolUse(event: OpenCodeToolUseEvent): RunnerEventTool {
  const toolEvent: RunnerEventTool = {
    type: "tool",
    provider: "opencode",
    name: normalizeOpenCodeToolName(event.part.tool),
    input: getOpenCodeToolInput(event),
  };
  const status = getOpenCodeToolStatus(event.part.state?.status);
  if (status) toolEvent.status = status;
  return toolEvent;
}

function getOpenCodeToolInput(event: OpenCodeToolUseEvent): Record<string, unknown> {
  const input = event.part.state?.input ?? event.part.input;
  return isRecord(input) ? input : {};
}

function getOpenCodeToolStatus(status: string | undefined): RunnerEventTool["status"] | undefined {
  return status === "started" || status === "completed" ? status : undefined;
}

function normalizeOpenCodeToolName(name: string): string {
  const names: Record<string, string> = {
    bash: "Bash",
    read: "Read",
    edit: "Edit",
    write: "Write",
    grep: "Grep",
    glob: "Glob",
    task: "Task",
  };
  return names[name.toLowerCase()] ?? name;
}
