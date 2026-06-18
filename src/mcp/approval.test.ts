import { afterEach, describe, expect, it } from "bun:test";
import {
  approvalTimeoutMs,
  registerPendingApproval,
  resolvePendingApproval,
} from "./approval.ts";

afterEach(() => {
  delete process.env.CLAUDE_APPROVAL_TIMEOUT_MS;
});

describe("pending approval registry", () => {
  it("resolves with the human decision via resolvePendingApproval", async () => {
    const token = crypto.randomUUID();
    const promise = registerPendingApproval(token, 5_000);
    expect(resolvePendingApproval(token, "allow")).toBe(true);
    await expect(promise).resolves.toBe("allow");
  });

  it("default-denies after the timeout", async () => {
    const token = crypto.randomUUID();
    const promise = registerPendingApproval(token, 20);
    await expect(promise).resolves.toBe("deny");
  });

  it("returns false for an unknown token", () => {
    expect(resolvePendingApproval("nope", "allow")).toBe(false);
  });

  it("is idempotent — second resolve returns false", async () => {
    const token = crypto.randomUUID();
    const promise = registerPendingApproval(token, 5_000);
    expect(resolvePendingApproval(token, "deny")).toBe(true);
    expect(resolvePendingApproval(token, "allow")).toBe(false);
    await expect(promise).resolves.toBe("deny");
  });

  it("reads CLAUDE_APPROVAL_TIMEOUT_MS lazily from env", () => {
    process.env.CLAUDE_APPROVAL_TIMEOUT_MS = "1234";
    expect(approvalTimeoutMs()).toBe(1234);
  });

  it("falls back to the default timeout for invalid env", () => {
    process.env.CLAUDE_APPROVAL_TIMEOUT_MS = "not-a-number";
    expect(approvalTimeoutMs()).toBe(240_000);
  });
});
