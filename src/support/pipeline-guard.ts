import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ThreadSession } from "../session/types.ts";

export interface BugPipelineState {
  bugId?: string;
  product?: string;
  status?: string;
  slackChannel?: string;
  slackThread?: string;
}

export type LeadPipelineValidation =
  | { action: "allow"; state?: BugPipelineState }
  | { action: "continue"; state: BugPipelineState; reason: string; prompt: string }
  | { action: "blocker"; state: BugPipelineState; reason: string; message: string };

const ADVANCE_REQUIRED_STATUSES = new Set([
  "intake",
  "researching",
  "observability_done",
]);

const PERSISTENT_ADVANCE_RE = /^!(reproducer|thinker)\b/m;
const BLOCKER_RE = /\b(blocker|blocked|needs-human|need human|escalat(?:e|ing|ion)|missing|cannot|can't|failed)\b/i;
const STATEFUL_WORKER_DONE_RE = /^DONE:\s+.*\b(?:New Relic|Sentry|Vercel|findings)\b.*\b(?:research|sentry|vercel)\.md\b/i;

export function validateLeadPipelineResponse(
  session: ThreadSession,
  response: string,
  supportChannels: Set<string>,
  retryCount: number,
): LeadPipelineValidation {
  if (session.activeAgentName !== "lead") return { action: "allow" };
  if (!supportChannels.has(session.channel)) return { action: "allow" };

  const state = findBugPipelineState(session);
  if (!state?.status) return { action: "allow" };
  if (!ADVANCE_REQUIRED_STATUSES.has(state.status)) return { action: "allow", state };

  const trimmed = response.trim();
  if (PERSISTENT_ADVANCE_RE.test(trimmed)) return { action: "allow", state };
  if (BLOCKER_RE.test(trimmed) && !STATEFUL_WORKER_DONE_RE.test(trimmed)) {
    return { action: "allow", state };
  }

  const reason = STATEFUL_WORKER_DONE_RE.test(trimmed)
    ? "lead returned stateless observability worker output"
    : `lead did not advance bug pipeline from status=${state.status}`;

  if (retryCount > 0) {
    return {
      action: "blocker",
      state,
      reason,
      message: [
        `Blocker: lead could not advance bug ${state.bugId ?? "(unknown)"} after observability.`,
        `Reason: ${reason}.`,
        "Needs human review before continuing.",
      ].join("\n"),
    };
  }

  return {
    action: "continue",
    state,
    reason,
    prompt: buildContinuationPrompt(state, trimmed, reason),
  };
}

export function looksLikePrReviewRequest(text: string): boolean {
  const hasPrLink = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/i.test(text);
  if (!hasPrLink) return false;
  return /\b(review|reviews|reviewed|please review|take a look|approve|approval)\b/i.test(text);
}

function buildContinuationPrompt(
  state: BugPipelineState,
  leakedResponse: string,
  reason: string,
): string {
  return [
    "Your previous lead turn ended before advancing the bug pipeline.",
    `Guard reason: ${reason}.`,
    `Bug: ${state.product ?? "unknown"}/${state.bugId ?? "unknown"} status=${state.status ?? "unknown"}.`,
    "",
    "Do not repeat raw observability worker output.",
    "Read the bug files under `support/bugs/<product>/<bugId>/`, synthesize observability, classify read-only vs write-path, then emit exactly one of:",
    "- `!reproducer <bounded reproduction prompt>` for read-only bugs",
    "- `!thinker <bounded scoping prompt>` for write-path bugs or after reproduction is unsafe",
    "- a concise blocker/escalation message if required data is missing",
    "",
    "Previous invalid response:",
    leakedResponse.slice(0, 2000),
  ].join("\n");
}

function findBugPipelineState(session: ThreadSession): BugPipelineState | null {
  const root = process.env.JUNIOR_BUG_ROOT ?? "support/bugs";
  if (!existsSync(root)) return null;

  for (const product of safeReadDir(root)) {
    const productDir = join(root, product);
    for (const bugId of safeReadDir(productDir)) {
      const statePath = join(productDir, bugId, "state.json");
      if (!existsSync(statePath)) continue;
      const state = readJsonState(statePath);
      if (
        state?.slackThread === session.threadId &&
        state?.slackChannel === session.channel
      ) {
        return state;
      }
    }
  }
  return null;
}

function safeReadDir(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function readJsonState(path: string): BugPipelineState | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as BugPipelineState;
  } catch {
    return null;
  }
}
