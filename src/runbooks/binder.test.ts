import { describe, expect, it } from "bun:test";
import { bindInputs, redactBoundInputs } from "./binder.ts";
import type { RunbookDefinition, RunbookInput } from "./types.ts";

function makeRunbook(inputs: RunbookInput[]): RunbookDefinition {
  return {
    schemaVersion: 1,
    name: "test-binder-runbook",
    description: "A minimal runbook for binder tests",
    ownerAgent: "build",
    intent: { examples: ["do a thing"], excludes: [] },
    inputs,
    risk: "read-only",
    approval: { required: false },
    capabilities: [],
    verification: { required: false, assertions: [] },
    tags: [],
    prompt: "Do the thing.",
    filePath: "test.runbook.md",
    origin: "private",
    contentDigest: "abc123",
  };
}

describe("bindInputs", () => {
  it("binds email inputs from context", () => {
    const rb = makeRunbook([
      { name: "sourceEmail", type: "email", required: true },
    ]);
    const result = bindInputs(rb, { sourceEmail: "alice@example.com" });
    expect(result.bound.sourceEmail).toBe("alice@example.com");
    expect(result.missing).toEqual([]);
  });

  it("validates email format (rejects invalid email)", () => {
    const rb = makeRunbook([
      { name: "sourceEmail", type: "email", required: true },
    ]);
    const result = bindInputs(rb, { sourceEmail: "not-an-email" });
    expect(result.bound.sourceEmail).toBeUndefined();
    expect(result.missing).toContain("sourceEmail");
  });

  it("binds objectId inputs (24-char hex string)", () => {
    const rb = makeRunbook([
      { name: "userId", type: "objectId", required: true },
    ]);
    const result = bindInputs(rb, { userId: "507f1f77bcf86cd799439011" });
    expect(result.bound.userId).toBe("507f1f77bcf86cd799439011");
    expect(result.missing).toEqual([]);
  });

  it("rejects invalid objectId (wrong length)", () => {
    const rb = makeRunbook([
      { name: "userId", type: "objectId", required: true },
    ]);
    const result = bindInputs(rb, { userId: "507f1f77" });
    expect(result.bound.userId).toBeUndefined();
    expect(result.missing).toContain("userId");
  });

  it("rejects invalid objectId (non-hex characters)", () => {
    const rb = makeRunbook([
      { name: "userId", type: "objectId", required: true },
    ]);
    const result = bindInputs(rb, { userId: "507f1f77bcf86cd79943ZZZZ" });
    expect(result.bound.userId).toBeUndefined();
    expect(result.missing).toContain("userId");
  });

  it("binds number inputs", () => {
    const rb = makeRunbook([
      { name: "count", type: "number", required: true },
    ]);
    const result = bindInputs(rb, { count: "42" });
    expect(result.bound.count).toBe(42);
    expect(result.missing).toEqual([]);
  });

  it("rejects non-numeric strings for number type", () => {
    const rb = makeRunbook([
      { name: "count", type: "number", required: true },
    ]);
    const result = bindInputs(rb, { count: "not-a-number" });
    expect(result.bound.count).toBeUndefined();
    expect(result.missing).toContain("count");
  });

  it("binds boolean inputs (true/false/yes/no/1/0)", () => {
    const rb = makeRunbook([
      { name: "dryRun", type: "boolean", required: true },
    ]);

    for (const [raw, expected] of [
      ["true", true],
      ["false", false],
      ["yes", true],
      ["no", false],
      ["1", true],
      ["0", false],
    ] as Array<[string, boolean]>) {
      const result = bindInputs(rb, { dryRun: raw });
      expect(result.bound.dryRun).toBe(expected);
      expect(result.missing).toEqual([]);
    }
  });

  it("binds enum inputs when value is in enumValues", () => {
    const rb = makeRunbook([
      {
        name: "env",
        type: "enum",
        required: true,
        enumValues: ["staging", "production"],
      },
    ]);
    const result = bindInputs(rb, { env: "staging" });
    expect(result.bound.env).toBe("staging");
    expect(result.missing).toEqual([]);
  });

  it("rejects enum values not in enumValues", () => {
    const rb = makeRunbook([
      {
        name: "env",
        type: "enum",
        required: true,
        enumValues: ["staging", "production"],
      },
    ]);
    const result = bindInputs(rb, { env: "development" });
    expect(result.bound.env).toBeUndefined();
    expect(result.missing).toContain("env");
  });

  it("binds string inputs (any value)", () => {
    const rb = makeRunbook([
      { name: "note", type: "string", required: true },
    ]);
    const result = bindInputs(rb, { note: "anything at all" });
    expect(result.bound.note).toBe("anything at all");
    expect(result.missing).toEqual([]);
  });

  it("reports missing required inputs", () => {
    const rb = makeRunbook([
      { name: "sourceEmail", type: "email", required: true },
      { name: "targetEmail", type: "email", required: true },
    ]);
    const result = bindInputs(rb, { sourceEmail: "a@b.com" });
    expect(result.bound.sourceEmail).toBe("a@b.com");
    expect(result.missing).toContain("targetEmail");
  });

  it("does not report missing optional inputs", () => {
    const rb = makeRunbook([
      { name: "note", type: "string", required: false },
    ]);
    const result = bindInputs(rb, {});
    expect(result.missing).toEqual([]);
    expect(result.bound.note).toBeUndefined();
  });

  it("context key matching is case-insensitive", () => {
    const rb = makeRunbook([
      { name: "sourceEmail", type: "email", required: true },
    ]);
    const result = bindInputs(rb, { sourceemail: "user@example.com" });
    expect(result.bound.sourceEmail).toBe("user@example.com");
    expect(result.missing).toEqual([]);
  });
});

describe("redactBoundInputs", () => {
  it("masks emails: 'user@example.com' -> 'u***@example.com'", () => {
    const rb = makeRunbook([
      { name: "sourceEmail", type: "email", required: true },
    ]);
    const redacted = redactBoundInputs(
      { sourceEmail: "user@example.com" },
      rb,
    );
    expect(redacted.sourceEmail).toBe("u***@example.com");
  });

  it("masks objectIds: keeps first 4 and last 4 chars", () => {
    const rb = makeRunbook([
      { name: "userId", type: "objectId", required: true },
    ]);
    const redacted = redactBoundInputs(
      { userId: "507f1f77bcf86cd799439011" },
      rb,
    );
    expect(redacted.userId).toBe("507f***9011");
  });

  it("passes through string/number/boolean values unchanged", () => {
    const rb = makeRunbook([
      { name: "note", type: "string", required: true },
      { name: "count", type: "number", required: true },
      { name: "dryRun", type: "boolean", required: true },
    ]);
    const redacted = redactBoundInputs(
      { note: "hello world", count: 42, dryRun: true },
      rb,
    );
    expect(redacted.note).toBe("hello world");
    expect(redacted.count).toBe("42");
    expect(redacted.dryRun).toBe("true");
  });
});
