// Stream-json event types matching actual Claude Code CLI output

export interface StreamEventInit {
  type: "system";
  subtype: "init";
  session_id: string;
  cwd?: string;
  tools?: string[];
}

export interface ContentBlockText {
  type: "text";
  text: string;
}

export interface ContentBlockToolUse {
  type: "tool_use";
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export interface ContentBlockThinking {
  type: "thinking";
  thinking?: string;
}

export type ContentBlock = ContentBlockText | ContentBlockToolUse | ContentBlockThinking;

export interface StreamEventAssistant {
  type: "assistant";
  message: {
    model?: string;
    id?: string;
    role: "assistant";
    content: ContentBlock[];
  };
}

export interface StreamEventResult {
  type: "result";
  subtype: string; // "success", "error_max_turns", etc.
  result?: string;
  text?: string;
}

export interface StreamEventUser {
  type: "user";
}

export interface StreamEventRateLimit {
  type: "rate_limit_event";
}

export type StreamEvent =
  | StreamEventInit
  | StreamEventAssistant
  | StreamEventResult
  | StreamEventUser
  | StreamEventRateLimit;

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
