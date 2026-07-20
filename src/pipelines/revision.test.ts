import { describe, expect, it } from "bun:test";
import {
  canonicalizeRevisionMembers,
  computeRevisionDigest,
  revisionVectorChanged,
} from "./revision.ts";
import type { AttemptRevisionMember } from "./types.ts";

const member = (
  overrides: Partial<AttemptRevisionMember> & Pick<AttemptRevisionMember, "memberKey">,
): AttemptRevisionMember => ({
  repoRef: "example-backend",
  branch: "feature/x",
  headSha: "aaa",
  ...overrides,
});

describe("revision vectors", () => {
  it("canonicalizes by sorting memberKey", () => {
    const members = [
      member({ memberKey: "b", headSha: "bbb" }),
      member({ memberKey: "a", headSha: "aaa" }),
    ];
    const canonical = canonicalizeRevisionMembers(members);
    expect(canonical.map((m) => m.memberKey)).toEqual(["a", "b"]);
  });

  it("produces a stable digest independent of input order", () => {
    const a = [
      member({ memberKey: "frontend", repoRef: "example-frontend", headSha: "f1" }),
      member({ memberKey: "backend", headSha: "b1" }),
    ];
    const b = [
      member({ memberKey: "backend", headSha: "b1" }),
      member({ memberKey: "frontend", repoRef: "example-frontend", headSha: "f1" }),
    ];
    expect(computeRevisionDigest(a)).toBe(computeRevisionDigest(b));
  });

  it("changes digest when any member headSha changes", () => {
    const base = [
      member({ memberKey: "backend", headSha: "sha-a" }),
      member({ memberKey: "frontend", repoRef: "example-frontend", headSha: "sha-f" }),
    ];
    const changed = [
      member({ memberKey: "backend", headSha: "sha-a2" }),
      member({ memberKey: "frontend", repoRef: "example-frontend", headSha: "sha-f" }),
    ];
    expect(revisionVectorChanged(base, changed)).toBe(true);
    expect(computeRevisionDigest(base)).not.toBe(computeRevisionDigest(changed));
  });

  it("allows multiple members in the same repository", () => {
    const members = [
      member({
        memberKey: "backend-dev",
        repoRef: "example-backend",
        branch: "dev/fix",
        headSha: "d1",
      }),
      member({
        memberKey: "backend-main",
        repoRef: "example-backend",
        branch: "main/fix",
        headSha: "m1",
      }),
    ];
    const digest = computeRevisionDigest(members);
    expect(digest).toHaveLength(64);

    const oneChanged = [
      members[0]!,
      { ...members[1]!, headSha: "m2" },
    ];
    expect(revisionVectorChanged(members, oneChanged)).toBe(true);
  });

  it("does not report change for equivalent vectors", () => {
    const a = [member({ memberKey: "backend", headSha: "x" })];
    const b = [member({ memberKey: "backend", headSha: "x" })];
    expect(revisionVectorChanged(a, b)).toBe(false);
  });
});
