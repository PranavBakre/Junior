import { readFileSync } from "node:fs";

export interface BuildOpenCodeAgentPromptOptions {
  juniorAgentName?: string | null;
  juniorCore?: string | null;
  juniorPrompt?: string | null;
}

export const OPENCODE_PROVIDER_AGENT = "build";

const FALLBACK_JUNIOR_CORE_PROMPT = [
  "# Core operating contract",
  "",
  "## First step: infer the required action",
  "",
  "Before responding, classify the user's message:",
  "",
  "1. Answer only - explanation, opinion, or requested plan.",
  "2. Act now - inspect, edit, run, commit, open a PR, review, verify, dispatch an agent, or update a document.",
  "3. Ask first - destructive action, ambiguous target, outside workspace, or required context is missing.",
  "",
  "If action is required, do the action. Do not only describe how to do it.",
].join("\n");

export const OPENCODE_JUNIOR_CORE_PROMPT = readBundledCorePrompt();

export const OPENCODE_PROVIDER_BASE_PROMPT = [
  "<opencode-provider-baseline>",
  "You are Junior running inside OpenCode as a Slack-controlled coding agent.",
  "",
  "Use OpenCode's native tools to inspect files, search the workspace, edit code, and run verification commands. Read relevant code before changing it.",
  "",
  "Respect the active workspace. Work in the current directory and explicit user-provided paths. Do not modify unrelated repositories, shared origin checkouts, generated secrets, or user changes you did not make.",
  "",
  "Keep changes scoped to the request and aligned with local patterns. Do not introduce broad refactors, dependencies, or abstractions unless needed to finish safely.",
  "",
  "For code changes, run the most relevant typecheck, tests, linters, or targeted commands available. Report any command you could not run and the concrete blocker.",
  "",
  "Preserve Junior's orchestration model. Before deep exploration, split independent work into local critical path, parallel agent work, and deferred verification. Use Task/sub-agents or persistent Slack directives when that reduces context load or wall-clock time. Provider agent `build` is only the OpenCode native tool surface; Junior's active role is named below.",
  "",
  "If provider/runtime safety rules or explicit user instructions conflict with a Junior persona below, follow the higher-priority provider/runtime/user instruction.",
  "</opencode-provider-baseline>",
].join("\n");

export function buildOpenCodeAgentPrompt(
  options: BuildOpenCodeAgentPromptOptions = {},
): string {
  const juniorAgentName = options.juniorAgentName?.trim() || "default";
  const juniorCore = options.juniorCore?.trim() || OPENCODE_JUNIOR_CORE_PROMPT;
  const juniorPrompt = options.juniorPrompt?.trim();
  const sections = [
    OPENCODE_PROVIDER_BASE_PROMPT,
    [
      "<junior-core>",
      juniorCore,
      "</junior-core>",
    ].join("\n"),
    `<junior-active-agent>${juniorAgentName}</junior-active-agent>`,
  ];

  const dedupedJuniorPrompt = stripLeadingCorePrompt(juniorPrompt, juniorCore);
  if (dedupedJuniorPrompt) {
    sections.push(
      [
        "<junior-agent-prompt>",
        dedupedJuniorPrompt,
        "</junior-agent-prompt>",
      ].join("\n"),
    );
  }

  return sections.join("\n\n");
}

function readBundledCorePrompt(): string {
  try {
    return readFileSync(
      new URL("../../.claude/agents/common/core.md", import.meta.url),
      "utf8",
    ).trim();
  } catch {
    return FALLBACK_JUNIOR_CORE_PROMPT;
  }
}

function stripLeadingCorePrompt(
  juniorPrompt: string | undefined,
  juniorCore: string,
): string | null {
  const prompt = juniorPrompt?.trim();
  if (!prompt) return null;

  if (prompt === juniorCore) return null;
  if (prompt.startsWith(`${juniorCore}\n\n`)) {
    return prompt.slice(juniorCore.length).trim();
  }
  return prompt;
}
