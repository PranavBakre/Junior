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
const ACTIONS_START_ESCAPED = "&lt;junior-actions&gt;";
const ACTIONS_END_ESCAPED = "&lt;/junior-actions&gt;";

export type SlackActionButtonStyle = "primary" | "danger";

/**
 * Versioned structured target for mutating PR actions (merge, etc.).
 * Agents should include this when emitting merge buttons. Generic merge
 * prompts without an exact anchor are dropped so multi-PR threads cannot
 * pick the wrong PR from conversational recency.
 */
export type SlackResourceAnchor = {
  version: 1;
  repo: string;
  prNumber: number;
  headSha: string;
  expectedBase: string;
  runId?: string;
  expectedRunVersion?: number;
  reviewVerdictId?: string;
};

/** Action ids that mutate a PR and require a stored resource anchor. */
export const MUTATING_PR_ACTION_IDS = new Set([
  "review:merge-gxt-admin",
]);

export type SlackActionButtonSpec =
  | {
      id: string;
      label: string;
      style?: SlackActionButtonStyle;
      type: "dispatch_agent";
      agent: string;
      prompt: string;
      resourceAnchor?: SlackResourceAnchor;
    }
  | {
      id: string;
      label: string;
      style?: SlackActionButtonStyle;
      type: "cleanup_worktree";
    }
  | {
      id: string;
      label: string;
      style?: SlackActionButtonStyle;
      type: "request_permission";
      // The in-process pending-approval token both Allow/Deny buttons resolve.
      approvalToken: string;
      decision: "allow" | "deny";
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
    actions: parseActionButtonSpecs(extracted.jsonText, {
      responseText: visibleText,
    }),
  };
}

function extractJuniorActions(
  text: string,
): { text: string; jsonText: string } | null {
  const markers = findActionMarkers(text);
  if (!markers) return null;
  const { start, startMarker, endMarker } = markers;
  const end = text.indexOf(endMarker, start + startMarker.length);
  if (end === -1) {
    return {
      text: text.slice(0, start).trimEnd(),
      jsonText: "",
    };
  }

  return {
    text: `${text.slice(0, start)}${text.slice(end + endMarker.length)}`.trim(),
    jsonText: text.slice(start + startMarker.length, end).trim(),
  };
}

function findActionMarkers(
  text: string,
): { start: number; startMarker: string; endMarker: string } | null {
  const literalStart = text.indexOf(ACTIONS_START);
  const escapedStart = text.indexOf(ACTIONS_START_ESCAPED);
  if (literalStart === -1 && escapedStart === -1) return null;

  if (escapedStart !== -1 && (literalStart === -1 || escapedStart < literalStart)) {
    return {
      start: escapedStart,
      startMarker: ACTIONS_START_ESCAPED,
      endMarker: ACTIONS_END_ESCAPED,
    };
  }

  return {
    start: literalStart,
    startMarker: ACTIONS_START,
    endMarker: ACTIONS_END,
  };
}

export function parseActionButtonSpecs(
  jsonText: string,
  options: { responseText?: string } = {},
): SlackActionButtonSpec[] {
  if (!jsonText) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const proseCandidates = options.responseText
    ? parseResourceAnchorCandidatesFromProse(options.responseText)
    : [];

  const actions: SlackActionButtonSpec[] = [];
  for (const candidate of parsed) {
    const action = normalizeActionButtonSpec(candidate, proseCandidates);
    if (action) actions.push(action);
    if (actions.length >= 5) break;
  }
  return actions;
}

/**
 * Best-effort prose extraction of PR targets. Used only as a candidate when the
 * action JSON lacks a full anchor; revalidated before storage and never used as
 * sole authority for multi-PR ambiguity.
 */
export function parseResourceAnchorCandidatesFromProse(
  text: string,
): SlackResourceAnchor[] {
  const anchors: SlackResourceAnchor[] = [];
  const seen = new Set<string>();
  const prUrl =
    /https?:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)/gi;
  let match: RegExpExecArray | null;
  while ((match = prUrl.exec(text)) !== null) {
    const repo = match[1];
    const prNumber = Number(match[2]);
    const key = `${repo}#${prNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Prose cannot supply headSha/base — partial candidates are not stored as
    // complete anchors. Returned only so callers can detect multi-PR ambiguity.
    anchors.push({
      version: 1,
      repo,
      prNumber,
      headSha: "",
      expectedBase: "",
    });
  }
  return anchors;
}

export function isCompleteResourceAnchor(
  anchor: SlackResourceAnchor | undefined | null,
): anchor is SlackResourceAnchor {
  if (!anchor || anchor.version !== 1) return false;
  if (!anchor.repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(anchor.repo)) {
    return false;
  }
  if (!Number.isInteger(anchor.prNumber) || anchor.prNumber <= 0) return false;
  if (!/^[0-9a-f]{7,40}$/i.test(anchor.headSha)) return false;
  if (!anchor.expectedBase || anchor.expectedBase.length > 200) return false;
  return true;
}

export function formatResourceAnchorForPrompt(anchor: SlackResourceAnchor): string {
  const lines = [
    "Exact PR target (do not infer a different PR from thread recency):",
    `- repo: ${anchor.repo}`,
    `- prNumber: ${anchor.prNumber}`,
    `- headSha: ${anchor.headSha}`,
    `- expectedBase: ${anchor.expectedBase}`,
  ];
  if (anchor.runId) lines.push(`- runId: ${anchor.runId}`);
  if (anchor.expectedRunVersion != null) {
    lines.push(`- expectedRunVersion: ${anchor.expectedRunVersion}`);
  }
  if (anchor.reviewVerdictId) {
    lines.push(`- reviewVerdictId: ${anchor.reviewVerdictId}`);
  }
  lines.push(
    "Revalidate that the PR head still matches headSha and the base is expectedBase before any merge. Stop if they do not match.",
  );
  return lines.join("\n");
}

function normalizeActionButtonSpec(
  value: unknown,
  proseCandidates: SlackResourceAnchor[] = [],
): SlackActionButtonSpec | null {
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
    const resourceAnchor = normalizeResourceAnchor(value.resourceAnchor);

    // Mutating PR actions require an exact stored anchor. Do not render a
    // generic merge button when the agent omitted it, or when prose shows
    // multiple PRs and the JSON did not pin one.
    if (MUTATING_PR_ACTION_IDS.has(id)) {
      if (!isCompleteResourceAnchor(resourceAnchor)) {
        // Single complete prose candidate is still not enough without head/base;
        // only accept a complete structured anchor.
        return null;
      }
      if (
        proseCandidates.length > 1 &&
        !proseCandidates.some(
          (c) =>
            c.repo === resourceAnchor.repo && c.prNumber === resourceAnchor.prNumber,
        )
      ) {
        // Anchor does not match any PR mentioned in the response — refuse.
        return null;
      }
    }

    return {
      id,
      label,
      ...(style ? { style } : {}),
      type,
      agent,
      prompt,
      ...(resourceAnchor && isCompleteResourceAnchor(resourceAnchor)
        ? { resourceAnchor }
        : {}),
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

function normalizeResourceAnchor(value: unknown): SlackResourceAnchor | null {
  if (!isRecord(value)) return null;
  const version = value.version === 1 || value.version === "1" ? 1 : null;
  if (version !== 1) return null;
  const repo = normalizeActionString(value.repo, 200);
  const expectedBase = normalizeActionString(value.expectedBase, 200);
  const headSha = normalizeActionString(value.headSha, 40);
  const prNumber =
    typeof value.prNumber === "number"
      ? value.prNumber
      : typeof value.prNumber === "string" && /^\d+$/.test(value.prNumber.trim())
        ? Number(value.prNumber.trim())
        : null;
  if (!repo || !expectedBase || !headSha || prNumber == null) return null;

  const anchor: SlackResourceAnchor = {
    version: 1,
    repo,
    prNumber,
    headSha,
    expectedBase,
  };

  const runId = normalizeActionString(value.runId, 120);
  if (runId) anchor.runId = runId;
  if (
    typeof value.expectedRunVersion === "number" &&
    Number.isInteger(value.expectedRunVersion) &&
    value.expectedRunVersion >= 0
  ) {
    anchor.expectedRunVersion = value.expectedRunVersion;
  }
  const reviewVerdictId = normalizeActionString(value.reviewVerdictId, 120);
  if (reviewVerdictId) anchor.reviewVerdictId = reviewVerdictId;

  return isCompleteResourceAnchor(anchor) ? anchor : null;
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
