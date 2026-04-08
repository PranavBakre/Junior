export interface StreamEventInit {
  type: "system";
  subtype: "init";
  session_id: string;
}

export interface StreamEventToolUse {
  type: "assistant";
  subtype: "tool_use";
  tool: string;
  input?: Record<string, unknown>;
}

export interface StreamEventText {
  type: "assistant";
  subtype: "text";
  text: string;
}

export interface StreamEventResult {
  type: "result";
  subtype: "success" | "error";
  text: string;
}

export type StreamEvent =
  | StreamEventInit
  | StreamEventToolUse
  | StreamEventText
  | StreamEventResult;

export interface SpawnResult {
  sessionId: string | null;
  response: string;
  events: StreamEvent[];
  exitCode: number | null;
  error: string | null;
}

export interface SpawnHandle {
  result: Promise<SpawnResult>;
  onEvent: (cb: (event: StreamEvent) => void) => void;
  kill: () => void;
  pid: number | null;
}
