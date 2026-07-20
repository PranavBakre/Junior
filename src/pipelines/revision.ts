import { createHash } from "node:crypto";
import type { AttemptRevisionMember } from "./types.ts";

/**
 * Canonicalize revision members: sort by stable `memberKey`, drop undefined
 * optional fields so digests are deterministic across serializers.
 */
export function canonicalizeRevisionMembers(
  members: AttemptRevisionMember[],
): AttemptRevisionMember[] {
  return [...members]
    .map((m) => ({
      memberKey: m.memberKey,
      repoRef: m.repoRef,
      branch: m.branch,
      headSha: m.headSha,
      ...(m.githubResourceId != null
        ? { githubResourceId: m.githubResourceId }
        : {}),
    }))
    .sort((a, b) => a.memberKey.localeCompare(b.memberKey));
}

/**
 * Stable digest of the full revision vector. Changing any member (including
 * one of several members in the same repository) changes the digest.
 */
export function computeRevisionDigest(
  members: AttemptRevisionMember[],
): string {
  const canonical = canonicalizeRevisionMembers(members);
  const payload = canonical
    .map(
      (m) =>
        `${m.memberKey}|${m.repoRef}|${m.branch}|${m.headSha}|${m.githubResourceId ?? ""}`,
    )
    .join("\n");
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * True when the two vectors differ under canonicalization (any member change
 * invalidates aggregate gates for the prior attempt).
 */
export function revisionVectorChanged(
  previous: AttemptRevisionMember[],
  next: AttemptRevisionMember[],
): boolean {
  return computeRevisionDigest(previous) !== computeRevisionDigest(next);
}
