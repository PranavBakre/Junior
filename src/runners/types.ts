import type { Config } from "../config.ts";
import type {
  AgentIdentity,
  RunnerProvider,
  ThreadSession,
} from "../session/types.ts";

export type { RunnerProvider } from "../session/types.ts";

export interface RunnerEventInit {
  type: "init";
  provider: RunnerProvider;
  sessionId: string;
}

export interface RunnerEventMessage {
  type: "message";
  provider: RunnerProvider;
  text: string;
}

export interface RunnerEventTool {
  type: "tool";
  provider: RunnerProvider;
  name: string;
  input: Record<string, unknown>;
  status?: "started" | "completed";
}

export interface RunnerEventDone {
  type: "done";
  provider: RunnerProvider;
  usage?: Record<string, unknown>;
}

export type RunnerEvent =
  | RunnerEventInit
  | RunnerEventMessage
  | RunnerEventTool
  | RunnerEventDone;

export interface SpawnResult {
  provider: RunnerProvider;
  sessionId: string | null;
  response: string;
  events: RunnerEvent[];
  exitCode: number | null;
  error: string | null;
}

export type RunnerKillSignal = "SIGINT" | "SIGTERM" | "SIGKILL";

export interface SpawnHandle {
  provider: RunnerProvider;
  result: Promise<SpawnResult>;
  onEvent: (cb: (event: RunnerEvent) => void) => void;
  kill: (signal?: RunnerKillSignal) => void;
  pid: number | null;
}

export type SpawnRunnerFn = (
  session: ThreadSession,
  prompt: string,
  config: Config,
  targetRepoCwd?: string,
  botToken?: string,
  agentIdentity?: AgentIdentity,
  imagePaths?: string[],
) => SpawnHandle;
