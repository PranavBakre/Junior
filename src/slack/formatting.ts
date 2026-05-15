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
