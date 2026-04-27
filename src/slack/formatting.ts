import type { ContentBlockToolUse, ContentBlockText, StreamEventAssistant } from "../claude/types.ts";

/**
 * Extract tool_use content blocks from an assistant event and format as status lines.
 */
export function formatToolStatuses(event: StreamEventAssistant): string[] {
  return event.message.content
    .filter((c): c is ContentBlockToolUse => c.type === "tool_use")
    .map(formatToolBlock);
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

export const NO_SLACK_MESSAGE = "NO_SLACK_MESSAGE";

export function shouldPostResponseToSlack(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  if (normalized === NO_SLACK_MESSAGE) return false;
  return true;
}

function formatToolBlock(block: ContentBlockToolUse): string {
  const tool = block.name ?? "Unknown";
  const input = block.input ?? {};

  switch (tool) {
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
