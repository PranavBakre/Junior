import type { ContentBlockToolUse, ContentBlockText, StreamEventAssistant } from "../claude/types.ts";
import type { RunnerEvent, RunnerEventMessage, RunnerEventTool } from "../runners/types.ts";

/**
 * Extract tool_use content blocks from an assistant event and format as status lines.
 */
export function formatToolStatuses(event: StreamEventAssistant): string[] {
  const toolBlocks = event.message.content.filter(
    (c): c is ContentBlockToolUse => c.type === "tool_use",
  );
  return formatRunnerToolStatuses(toolBlocks.map(toClaudeRunnerToolEvent));
}

/**
 * Extract normalized tool events and format them as Slack status lines.
 */
export function formatRunnerToolStatuses(
  events: RunnerEvent | RunnerEvent[],
): string[] {
  const toolEvents = (Array.isArray(events) ? events : [events]).filter(
    (event): event is RunnerEventTool => event.type === "tool",
  );
  const taskBlocks = toolEvents.filter((event) => event.name === "Task");
  const otherBlocks = toolEvents.filter((event) => event.name !== "Task");

  const statuses: string[] = [];
  if (taskBlocks.length > 1) {
    const names = taskBlocks.map(getTaskSubagentName);
    statuses.push(`Calling ${names.join(", ")} (${names.length} in progress)`);
  } else if (taskBlocks.length === 1) {
    statuses.push(formatToolEvent(taskBlocks[0]));
  }

  statuses.push(...otherBlocks.map(formatToolEvent));
  return statuses;
}

/**
 * Extract text content from an assistant event, if any.
 */
export function extractAssistantText(event: StreamEventAssistant): string | null {
  const texts = event.message.content
    .filter((c): c is ContentBlockText => c.type === "text" && !!c.text)
    .map((c) => c.text);
  return texts.length > 0 ? texts.join("") : null;
}

/**
 * Extract text from a normalized runner message event, if any.
 */
export function extractRunnerMessageText(event: RunnerEvent): string | null {
  return isRunnerMessageEvent(event) && event.text ? event.text : null;
}

export const NO_SLACK_MESSAGE = "NO_SLACK_MESSAGE";
export const ACTIONS_START = "<junior-actions>";
export const ACTIONS_END = "</junior-actions>";

export type SlackActionButtonStyle = "primary" | "danger";

export type SlackActionButtonSpec =
  | {
      id: string;
      label: string;
      style?: SlackActionButtonStyle;
      type: "dispatch_agent";
      agent: string;
      prompt: string;
    }
  | {
      id: string;
      label: string;
      style?: SlackActionButtonStyle;
      type: "cleanup_worktree";
    };

export interface SlackResponseWithActions {
  text: string;
  actions: SlackActionButtonSpec[];
}

const MAX_SLACK_ERROR_LENGTH = 500;
const PROMPT_LEAK_MARKERS = [
  /<\/?[a-z][a-z0-9-]*(?:\s[^>]*)?>/i,
  /#\s*(?:IDENTITY|SOUL)\.md\b/i,
  /Do NOT use Slack search/i,
  /CRITICAL\s+[—-]\s+no double-posting/i,
  /Your Slack user ID is\b/i,
  /File not found:\s*</i,
];

/**
 * Convert a runner/tool error into a Slack-safe message.
 *
 * Raw provider stderr can include the full prompt when a tool wrapper echoes a
 * bad argument (e.g. `File not found: <identity>...`). Keep the full error in
 * server logs, but never mirror prompt/context blocks back into Slack.
 */
export function sanitizeErrorForSlack(error: string | null | undefined): string {
  const cleaned = stripAnsi(error ?? "").trim();
  if (!cleaned) return "runner failed. Check server logs for details.";

  if (containsPromptLeak(cleaned)) {
    return "runner failed. Raw error withheld because it contained injected prompt/context; check server logs.";
  }

  if (cleaned.length > MAX_SLACK_ERROR_LENGTH) {
    return "runner failed. Raw error was too long to post safely; check server logs.";
  }

  return cleaned;
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function containsPromptLeak(text: string): boolean {
  return PROMPT_LEAK_MARKERS.some((marker) => marker.test(text));
}

/**
 * Decide whether to post `text` to Slack and what to post.
 * Returns null to suppress entirely; otherwise the cleaned text to post.
 *
 * Suppress when:
 *   - text is empty/whitespace
 *   - text is exactly the sentinel
 *
 * Strip + post when:
 *   - text has real content followed by a trailing sentinel — the agent
 *     intended to reply and habitually appended the sentinel; the reply
 *     itself is what humans need.
 */
export function prepareSlackResponse(text: string): string | null {
  let normalized = text.trim();
  if (!normalized) return null;
  if (normalized === NO_SLACK_MESSAGE) return null;
  if (normalized.endsWith(NO_SLACK_MESSAGE)) {
    normalized = normalized.slice(0, -NO_SLACK_MESSAGE.length).trimEnd();
    if (!normalized) return null;
  }
  return normalized;
}

export function prepareSlackResponseWithActions(
  text: string,
): SlackResponseWithActions | null {
  const prepared = prepareSlackResponse(text);
  if (prepared === null) return null;

  const extracted = extractJuniorActions(prepared);
  if (!extracted) return { text: prepared, actions: [] };

  const visibleText = extracted.text.trim();
  if (!visibleText) return null;

  return {
    text: visibleText,
    actions: parseActionButtonSpecs(extracted.jsonText),
  };
}

function extractJuniorActions(
  text: string,
): { text: string; jsonText: string } | null {
  const start = text.indexOf(ACTIONS_START);
  if (start === -1) return null;
  const end = text.indexOf(ACTIONS_END, start + ACTIONS_START.length);
  if (end === -1) {
    return {
      text: text.slice(0, start).trimEnd(),
      jsonText: "",
    };
  }

  return {
    text: `${text.slice(0, start)}${text.slice(end + ACTIONS_END.length)}`.trim(),
    jsonText: text.slice(start + ACTIONS_START.length, end).trim(),
  };
}

export function parseActionButtonSpecs(jsonText: string): SlackActionButtonSpec[] {
  if (!jsonText) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const actions: SlackActionButtonSpec[] = [];
  for (const candidate of parsed) {
    const action = normalizeActionButtonSpec(candidate);
    if (action) actions.push(action);
    if (actions.length >= 5) break;
  }
  return actions;
}

function normalizeActionButtonSpec(value: unknown): SlackActionButtonSpec | null {
  if (!isRecord(value)) return null;
  const id = normalizeActionString(value.id, 80);
  const label = normalizeActionString(value.label, 30);
  const style = normalizeActionStyle(value.style);
  const type = value.type;
  if (!id || !label) return null;

  if (type === "dispatch_agent") {
    const agent = normalizeActionString(value.agent, 80);
    const prompt = normalizeActionString(value.prompt, 2_000);
    if (!agent || !prompt) return null;
    return {
      id,
      label,
      ...(style ? { style } : {}),
      type,
      agent,
      prompt,
    };
  }

  if (type === "cleanup_worktree") {
    return {
      id,
      label,
      ...(style ? { style } : {}),
      type,
    };
  }

  return null;
}

function normalizeActionString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  return trimmed;
}

function normalizeActionStyle(value: unknown): SlackActionButtonStyle | null {
  return value === "primary" || value === "danger" ? value : null;
}

/**
 * Return true when the final runner response would duplicate text already sent
 * via the Slack MCP post tool in the same turn.
 *
 * Agents are instructed to return NO_SLACK_MESSAGE after calling
 * slack_send_message, but the failure mode is expensive: the MCP post lands,
 * then Junior posts the identical final response again. Suppress only exact
 * duplicate text so useful follow-up responses are still shown.
 */
export function isDuplicateSlackToolResponse(
  text: string,
  events: RunnerEvent[],
): boolean {
  const prepared = prepareSlackResponse(text);
  if (prepared === null) return false;

  const normalizedResponse = normalizeSlackPostText(prepared);
  return events.some((event) => {
    if (event.type !== "tool") return false;
    if (!isSlackSendMessageEvent(event)) return false;
    const postedText = findSlackPostText(event.input);
    return (
      typeof postedText === "string" &&
      normalizeSlackPostText(postedText) === normalizedResponse
    );
  });
}

function normalizeSlackPostText(text: string): string {
  return text.trim();
}

function isSlackSendMessageEvent(event: RunnerEventTool): boolean {
  if (isSlackSendMessageToolName(event.name)) return true;

  // Provider adapters don't all expose MCP tool names identically. Claude uses
  // names like `mcp__slack-bot__slack_send_message`; OpenCode may surface MCP
  // calls as a generic tool with the concrete name nested in the input.
  const inputToolName = findToolName(event.input);
  return !!inputToolName && isSlackSendMessageToolName(inputToolName);
}

function isSlackSendMessageToolName(toolName: string): boolean {
  const normalized = toolName.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return normalized === "slack_send_message" || normalized.endsWith("_slack_send_message");
}

function findToolName(value: unknown): string | null {
  if (!isRecord(value)) return null;
  for (const key of ["tool", "toolName", "tool_name", "name", "method"]) {
    const candidate = value[key];
    if (typeof candidate === "string" && isSlackSendMessageToolName(candidate)) {
      return candidate;
    }
  }
  for (const nested of Object.values(value)) {
    const candidate = findToolName(nested);
    if (candidate) return candidate;
  }
  return null;
}

function findSlackPostText(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const direct = value.text;
  if (typeof direct === "string") return direct;
  for (const nested of Object.values(value)) {
    const text = findSlackPostText(nested);
    if (text) return text;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatToolEvent(event: RunnerEventTool): string {
  const tool = event.name || "Unknown";
  const input = event.input ?? {};

  switch (tool) {
    case "Task": {
      return `Calling ${getTaskSubagentName(event)}`;
    }
    case "Bash": {
      const cmd = typeof input.command === "string" ? input.command : "";
      const short = cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd;
      return `Running: \`${short}\``;
    }
    case "Read": {
      const file = typeof input.file_path === "string" ? input.file_path : "";
      return `Reading \`${file}\``;
    }
    case "Edit":
    case "Write": {
      const file = typeof input.file_path === "string" ? input.file_path : "";
      return `Editing \`${file}\``;
    }
    case "Grep": {
      const pattern = typeof input.pattern === "string" ? input.pattern : "";
      return `Searching for \`${pattern}\``;
    }
    case "Glob": {
      const pattern = typeof input.pattern === "string" ? input.pattern : "";
      return `Searching for \`${pattern}\``;
    }
    default:
      return `Using ${tool}`;
  }
}

function getTaskSubagentName(event: RunnerEventTool): string {
  const input = event.input ?? {};
  return typeof input.subagent_type === "string" ? input.subagent_type : "agent";
}

function toClaudeRunnerToolEvent(block: ContentBlockToolUse): RunnerEventTool {
  return {
    type: "tool",
    provider: "claude",
    name: block.name ?? "Unknown",
    input: block.input ?? {},
  };
}

function isRunnerMessageEvent(event: RunnerEvent): event is RunnerEventMessage {
  return event.type === "message";
}

const DEFAULT_MAX_LENGTH = 4000;

export function splitResponse(
  text: string,
  maxLength: number = DEFAULT_MAX_LENGTH,
): string[] {
  if (!text) return [];

  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    const slice = remaining.slice(0, maxLength);

    // Try to split at a paragraph boundary (double newline)
    const lastParagraph = slice.lastIndexOf("\n\n");
    if (lastParagraph > maxLength * 0.3) {
      chunks.push(remaining.slice(0, lastParagraph).trimEnd());
      remaining = remaining.slice(lastParagraph + 2).trimStart();
      continue;
    }

    // Try to split at a single newline, but avoid splitting inside code blocks
    const codeBlockCount = (slice.match(/```/g) || []).length;
    const insideCodeBlock = codeBlockCount % 2 === 1;

    if (!insideCodeBlock) {
      const lastNewline = slice.lastIndexOf("\n");
      if (lastNewline > maxLength * 0.3) {
        chunks.push(remaining.slice(0, lastNewline).trimEnd());
        remaining = remaining.slice(lastNewline + 1);
        continue;
      }
    }

    // If inside a code block, try to find the closing ``` and split after it
    if (insideCodeBlock) {
      const closingFence = remaining.indexOf("```", slice.lastIndexOf("```") + 3);
      if (closingFence !== -1) {
        const endOfLine = remaining.indexOf("\n", closingFence);
        const splitPoint = endOfLine !== -1 ? endOfLine + 1 : closingFence + 3;
        if (splitPoint <= maxLength * 1.5) {
          chunks.push(remaining.slice(0, splitPoint).trimEnd());
          remaining = remaining.slice(splitPoint).trimStart();
          continue;
        }
      }
    }

    // Last resort: split at maxLength
    chunks.push(remaining.slice(0, maxLength));
    remaining = remaining.slice(maxLength);
  }

  return chunks;
}
