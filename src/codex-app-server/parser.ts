import type { RunnerEvent, RunnerEventTool } from "../runners/types.ts";
import { log } from "../logger.ts";

export interface CodexJsonRpcNotification {
  jsonrpc?: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface CodexAppServerStreamParser {
  feed(chunk: string): CodexJsonRpcNotification[];
  flush(): CodexJsonRpcNotification[];
}

export interface CodexAppServerEventMapper {
  readonly sessionId: string | null;
  readonly response: string;
  map(notification: CodexJsonRpcNotification): RunnerEvent[];
}

const TOOL_ITEM_TYPES = new Set([
  "commandExecution",
  "mcpToolCall",
  "dynamicToolCall",
  "collabToolCall",
  "webSearch",
  "fileChange",
  "imageView",
  "enteredReviewMode",
  "exitedReviewMode",
]);

const IGNORED_ITEM_TYPES = new Set([
  "compacted",
  "contextCompaction",
  "plan",
  "reasoning",
  "userMessage",
]);

const KNOWN_METHODS = new Set([
  "account/login/completed",
  "account/updated",
  "account/rateLimits/updated",
  "app/list/updated",
  "command/exec/outputDelta",
  "configWarning",
  "deprecationNotice",
  "error",
  "externalAgentConfig/import/completed",
  "fs/changed",
  "guardianWarning",
  "hook/completed",
  "hook/started",
  "thread/started",
  "turn/started",
  "turn/diff/updated",
  "turn/plan/updated",
  "model/rerouted",
  "model/verification",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/autoApprovalReview/started",
  "item/autoApprovalReview/completed",
  "item/plan/delta",
  "item/reasoning/summaryTextDelta",
  "item/reasoning/summaryPartAdded",
  "item/reasoning/textDelta",
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/fileChange/patchUpdated",
  "item/fileChange/outputDelta",
  "item/mcpToolCall/progress",
  "process/exited",
  "process/outputDelta",
  "remoteControl/status/changed",
  "serverRequest/resolved",
  "skills/changed",
  "thread/archived",
  "thread/closed",
  "thread/compacted",
  "thread/goal/cleared",
  "thread/goal/updated",
  "thread/name/updated",
  "thread/realtime/started",
  "thread/realtime/itemAdded",
  "thread/realtime/sdp",
  "thread/realtime/transcript/delta",
  "thread/realtime/transcript/done",
  "thread/realtime/outputAudio/delta",
  "thread/realtime/error",
  "thread/realtime/closed",
  "thread/settings/updated",
  "turn/completed",
  "thread/status/changed",
  "thread/tokenUsage/updated",
  "thread/unarchived",
  "warning",
  "fuzzyFileSearch/sessionUpdated",
  "fuzzyFileSearch/sessionCompleted",
  "windows/worldWritableWarning",
  "windowsSandbox/setupCompleted",
  "mcpServer/oauthLogin/completed",
  "mcpServer/startupStatus/updated",
]);

export function createCodexAppServerStreamParser(): CodexAppServerStreamParser {
  let buffer = "";

  function drain(consumePartial: boolean): CodexJsonRpcNotification[] {
    const notifications: CodexJsonRpcNotification[] = [];
    let newlineIdx = buffer.indexOf("\n");

    while (newlineIdx !== -1) {
      const notification = parseLine(buffer.slice(0, newlineIdx));
      if (notification) notifications.push(notification);
      buffer = buffer.slice(newlineIdx + 1);
      newlineIdx = buffer.indexOf("\n");
    }

    if (consumePartial && buffer.trim()) {
      const notification = parseLine(buffer);
      if (notification) notifications.push(notification);
      buffer = "";
    }

    return notifications;
  }

  return {
    feed(chunk: string): CodexJsonRpcNotification[] {
      buffer += chunk;
      return drain(false);
    },
    flush(): CodexJsonRpcNotification[] {
      return drain(true);
    },
  };
}

export function createCodexAppServerEventMapper(): CodexAppServerEventMapper {
  let sessionId: string | null = null;
  let response = "";
  let pendingText = "";

  function maybeInitFromParams(params: Record<string, unknown> | undefined): RunnerEvent[] {
    if (sessionId || !params) return [];
    const thread = asRecord(params.thread);
    const id = stringValue(thread?.id) ?? stringValue(params.threadId);
    if (!id) return [];
    sessionId = id;
    return [{ type: "init", provider: "codex-app-server", sessionId: id }];
  }

  return {
    get sessionId(): string | null {
      return sessionId;
    },
    get response(): string {
      return response;
    },
    map(notification: CodexJsonRpcNotification): RunnerEvent[] {
      const params = notification.params;
      const events = maybeInitFromParams(params);

      if (!KNOWN_METHODS.has(notification.method)) {
        log.info("codex-app-server", `Unmapped notification method "${notification.method}"`);
      }

      if (notification.method === "item/agentMessage/delta") {
        pendingText += stringValue(params?.delta) ?? "";
        return events;
      }

      if (notification.method === "item/started" || notification.method === "item/completed") {
        if (notification.method === "item/completed") {
          const text = completedItemAgentMessageText(params);
          if (text) {
            response = text;
            pendingText = "";
            events.push({
              type: "message",
              provider: "codex-app-server",
              text,
            });
            return events;
          }
        }
        const tool = mapToolItem(params, notification.method === "item/completed" ? "completed" : "started");
        if (tool) events.push(tool);
        return events;
      }

      if (notification.method === "turn/completed") {
        const text = completedAgentMessageText(params);
        const finalText = text || pendingText;
        if (finalText) {
          response = finalText;
          events.push({
            type: "message",
            provider: "codex-app-server",
            text: finalText,
          });
          pendingText = "";
        }
        const usage = asRecord(params?.usage) ?? asRecord(asRecord(params?.turn)?.usage);
        events.push({
          type: "done",
          provider: "codex-app-server",
          ...(usage ? { usage } : {}),
        });
      }

      return events;
    },
  };
}

function parseLine(line: string): CodexJsonRpcNotification | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    log.warn(
      "codex-app-server",
      `Dropped malformed JSON-RPC line (${(err as Error).message}): ${trimmed.slice(0, 200)}`,
    );
    return null;
  }

  if (!isRecord(parsed) || typeof parsed.method !== "string" || "id" in parsed) {
    return null;
  }

  return {
    jsonrpc: parsed.jsonrpc === "2.0" ? "2.0" : undefined,
    method: parsed.method,
    params: asRecord(parsed.params),
  };
}

function mapToolItem(
  params: Record<string, unknown> | undefined,
  status: "started" | "completed",
): RunnerEventTool | null {
  const item = asRecord(params?.item);
  const type = stringValue(item?.type);
  if (!item || !type) return null;
  if (!TOOL_ITEM_TYPES.has(type)) {
    if (!IGNORED_ITEM_TYPES.has(type)) {
      log.info("codex-app-server", `Unmapped item type "${type}"`);
    }
    return null;
  }

  return {
    type: "tool",
    provider: "codex-app-server",
    name: codexToolName(type, item),
    input: {
      ...item,
      codexItemType: type,
      turnId: params?.turnId,
      threadId: params?.threadId,
    },
    status,
  };
}

function codexToolName(type: string, item: Record<string, unknown>): string {
  if (type === "commandExecution") return "Bash";
  if (type === "mcpToolCall") return stringValue(item.tool) ?? "MCP";
  if (type === "dynamicToolCall") return stringValue(item.name) ?? "DynamicTool";
  if (type === "collabToolCall") return "Task";
  if (type === "webSearch") return "WebSearch";
  if (type === "fileChange") return "Edit";
  if (type === "imageView") return "Read";
  if (type === "enteredReviewMode" || type === "exitedReviewMode") return "Review";
  return type;
}

function completedAgentMessageText(params: Record<string, unknown> | undefined): string {
  const turn = asRecord(params?.turn);
  const items = Array.isArray(turn?.items) ? turn.items : [];
  const texts = items
    .map(asRecord)
    .filter((item): item is Record<string, unknown> => item?.type === "agentMessage")
    .map(agentMessageText)
    .filter(Boolean);
  return texts.join("\n\n");
}

function completedItemAgentMessageText(params: Record<string, unknown> | undefined): string {
  const item = asRecord(params?.item);
  if (item?.type !== "agentMessage") return "";
  return agentMessageText(item);
}

function agentMessageText(item: Record<string, unknown>): string {
  const direct = stringValue(item.text) ?? stringValue(item.message);
  if (direct) return direct;

  const content = Array.isArray(item.content) ? item.content : [];
  return content
    .map(asRecord)
    .map((part) => stringValue(part?.text) ?? "")
    .filter(Boolean)
    .join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
