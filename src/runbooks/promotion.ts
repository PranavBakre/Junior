import { listRunbooks, searchRunbooks } from "./registry.ts";
import { classifyReusablePattern } from "./classifier.ts";
import type { RunbookRunEvidence } from "./evidence.ts";
import { normalizeForFingerprint } from "./evidence.ts";
import type { PromotionCandidate } from "./types.ts";

const DEFAULT_THRESHOLD = 3;
const STALE_DAYS = 90;
const MS_PER_DAY = 86_400_000;

const candidates = new Map<string, PromotionCandidate>();

export function recordSuccessfulExecution(
  evidence: RunbookRunEvidence,
  request?: string,
): void {
  const fp = evidence.intentFingerprint;
  const existing = candidates.get(fp);
  const normalizedText = request ? normalizeForFingerprint(request) : "";

  if (existing) {
    existing.occurrenceCount++;
    if (evidence.status === "completed") existing.successfulCount++;
    existing.lastSeenAt = evidence.completedAt ?? evidence.startedAt;
    if (!existing.evidenceRefs.includes(evidence.runId)) {
      existing.evidenceRefs.push(evidence.runId);
    }
    if (evidence.risk && !existing.risk) existing.risk = evidence.risk;
    if (normalizedText && !existing.normalizedIntent) existing.normalizedIntent = normalizedText;
    return;
  }

  const classification = classifyReusablePattern(
    normalizedText,
    evidence.ownerAgent,
    evidence.risk,
    [],
    1,
  );

  candidates.set(fp, {
    fingerprint: fp,
    proposedKind: classification.classification === "memory-claim"
      ? "runbook"
      : (classification.classification as PromotionCandidate["proposedKind"]),
    normalizedIntent: normalizedText,
    ownerAgent: evidence.ownerAgent,
    occurrenceCount: 1,
    successfulCount: evidence.status === "completed" ? 1 : 0,
    firstSeenAt: evidence.startedAt,
    lastSeenAt: evidence.completedAt ?? evidence.startedAt,
    evidenceRefs: [evidence.runId],
    procedureMemoryIds: [],
    status: "tracking",
    risk: evidence.risk,
    capabilities: [],
  });
}

export function recordProcedureMemoryLink(
  fingerprint: string,
  memoryId: string,
): void {
  const candidate = candidates.get(fingerprint);
  if (!candidate) return;
  if (!candidate.procedureMemoryIds.includes(memoryId)) {
    candidate.procedureMemoryIds.push(memoryId);
  }
}

export interface PromotionCheck {
  shouldPropose: boolean;
  reason: string;
  candidate: PromotionCandidate | null;
}

export function checkPromotionThreshold(
  fingerprint: string,
  options?: { threshold?: number; explicitRequest?: boolean },
): PromotionCheck {
  const candidate = candidates.get(fingerprint);
  if (!candidate) {
    return { shouldPropose: false, reason: "no candidate found", candidate: null };
  }

  if (candidate.status !== "tracking") {
    return {
      shouldPropose: false,
      reason: `candidate already ${candidate.status}`,
      candidate,
    };
  }

  if (options?.explicitRequest) {
    return {
      shouldPropose: true,
      reason: "explicit human request bypasses count threshold",
      candidate,
    };
  }

  const threshold = options?.threshold ?? DEFAULT_THRESHOLD;
  if (candidate.successfulCount >= threshold) {
    return {
      shouldPropose: true,
      reason: `${candidate.successfulCount} successful executions meet threshold of ${threshold}`,
      candidate,
    };
  }

  return {
    shouldPropose: false,
    reason: `${candidate.successfulCount}/${threshold} successful executions`,
    candidate,
  };
}

export interface DeduplicationResult {
  isDuplicate: boolean;
  existingName?: string;
  existingKind?: "runbook" | "agent";
  overlapScore?: number;
}

export function deduplicateAgainstExisting(
  candidate: PromotionCandidate,
): DeduplicationResult {
  const runbooks = listRunbooks();
  for (const rb of runbooks) {
    const overlap = computeOverlap(candidate, rb.name, rb.description, rb.tags);
    if (overlap > 0.5) {
      return {
        isDuplicate: true,
        existingName: rb.name,
        existingKind: "runbook",
        overlapScore: overlap,
      };
    }
  }

  const agentResults = searchRunbooks({ query: candidate.ownerAgent });
  if (agentResults.length > 0) {
    for (const ar of agentResults) {
      const overlap = computeOverlap(candidate, ar.name, ar.description, ar.tags);
      if (overlap > 0.5) {
        return {
          isDuplicate: true,
          existingName: ar.name,
          existingKind: "runbook",
          overlapScore: overlap,
        };
      }
    }
  }

  return { isDuplicate: false };
}

function computeOverlap(
  candidate: PromotionCandidate,
  name: string,
  description: string,
  tags: string[],
): number {
  const candidateTokens = tokenize(candidate.normalizedIntent);
  const existingTokens = tokenize(`${name} ${description} ${tags.join(" ")}`);

  if (candidateTokens.size === 0 && existingTokens.size === 0) return 0;

  let intersection = 0;
  for (const t of candidateTokens) {
    if (existingTokens.has(t)) intersection++;
  }
  const union = candidateTokens.size + existingTokens.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1),
  );
}

export function listCandidates(
  options?: { status?: string; minOccurrences?: number },
): PromotionCandidate[] {
  const results: PromotionCandidate[] = [];
  for (const c of candidates.values()) {
    if (options?.status && c.status !== options.status) continue;
    if (options?.minOccurrences && c.occurrenceCount < options.minOccurrences)
      continue;
    results.push(c);
  }
  return results;
}

export function getCandidate(
  fingerprint: string,
): PromotionCandidate | undefined {
  return candidates.get(fingerprint);
}

export function updateCandidateStatus(
  fingerprint: string,
  status: PromotionCandidate["status"],
): boolean {
  const candidate = candidates.get(fingerprint);
  if (!candidate) return false;
  candidate.status = status;
  return true;
}

export function archiveStaleCandidate(
  fingerprint: string,
  reason: string,
): boolean {
  const candidate = candidates.get(fingerprint);
  if (!candidate) return false;
  candidate.status = "archived";
  return true;
}

export function findStaleCandidates(
  options?: { maxAgeDays?: number; now?: number },
): PromotionCandidate[] {
  const maxAge = (options?.maxAgeDays ?? STALE_DAYS) * MS_PER_DAY;
  const now = options?.now ?? Date.now();
  const results: PromotionCandidate[] = [];

  for (const c of candidates.values()) {
    if (c.status === "archived" || c.status === "accepted") continue;
    if (now - c.lastSeenAt > maxAge) {
      results.push(c);
    }
  }

  return results;
}

export function clearCandidatesForTests(): void {
  candidates.clear();
}
