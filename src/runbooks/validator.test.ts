import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import path from "node:path";
import fs from "node:fs/promises";
import { validateRunbook } from "./validator.ts";
import { loadRunbookDefinition } from "./loader.ts";
import type { RunbookDefinition } from "./types.ts";
import {
  AGENT_IDENTITIES,
  registerAgentIdentity,
} from "../support/agents.ts";

const fixtureDir = path.join(import.meta.dir, "__fixtures__");
const fixturePath = path.join(fixtureDir, "transfer-ai-roadmaps.runbook.md");

/** Build a minimal valid RunbookDefinition for inline tests. */
function makeValidDef(overrides?: Partial<RunbookDefinition>): RunbookDefinition {
  return {
    schemaVersion: 1,
    name: "test-runbook",
    description: "A test runbook",
    ownerAgent: "build",
    intent: {
      examples: ["do a test thing"],
      excludes: ["do something else"],
    },
    inputs: [
      { name: "target", type: "string", required: true },
    ],
    risk: "workspace-write",
    approval: { required: false },
    capabilities: ["mongo.read"],
    verification: { required: true, assertions: ["thing was done"] },
    tags: ["test"],
    prompt: "Do the test thing.",
    filePath: "/tmp/test-runbook.runbook.md",
    origin: "private",
    contentDigest: "abc123",
    ...overrides,
  };
}

describe("validateRunbook", () => {
  beforeEach(() => {
    registerAgentIdentity("db-executioner", {
      username: "DB Executioner",
      iconEmoji: ":database:",
    });
  });

  afterEach(() => {
    delete AGENT_IDENTITIES["db-executioner"];
  });

  it("valid definition produces zero errors", () => {
    const def = makeValidDef();
    const errors = validateRunbook(def, "test-runbook");
    expect(errors).toEqual([]);
  });

  it("valid fixture produces zero errors", async () => {
    const result = await loadRunbookDefinition(fixturePath);
    expect(result.ok).toBe(true);
  });

  describe("name validation", () => {
    it("accepts kebab-case name", () => {
      const def = makeValidDef({ name: "foo-bar" });
      const errors = validateRunbook(def, "foo-bar");
      const nameErrors = errors.filter((e) => e.field === "name");
      expect(nameErrors).toEqual([]);
    });

    it("rejects non-kebab-case name", () => {
      const def = makeValidDef({ name: "Foo_Bar" });
      const errors = validateRunbook(def, "Foo_Bar");
      expect(errors.some((e) => e.field === "name" && e.message.includes("kebab-case"))).toBe(
        true,
      );
    });

    it("rejects name that does not match filename", () => {
      const def = makeValidDef({ name: "foo" });
      const errors = validateRunbook(def, "bar");
      expect(
        errors.some((e) => e.field === "name" && e.message.includes("does not match")),
      ).toBe(true);
    });

    it("rejects empty name", () => {
      const def = makeValidDef({ name: "" });
      const errors = validateRunbook(def, "");
      expect(errors.some((e) => e.field === "name" && e.message.includes("required"))).toBe(
        true,
      );
    });
  });

  describe("schemaVersion", () => {
    it("accepts schemaVersion 1", () => {
      const def = makeValidDef({ schemaVersion: 1 });
      const errors = validateRunbook(def, "test-runbook");
      expect(errors.filter((e) => e.field === "schemaVersion")).toEqual([]);
    });

    it("rejects schemaVersion other than 1", () => {
      const def = makeValidDef({ schemaVersion: 2 });
      const errors = validateRunbook(def, "test-runbook");
      expect(
        errors.some(
          (e) => e.field === "schemaVersion" && e.message.includes("expected 1"),
        ),
      ).toBe(true);
    });
  });

  describe("description", () => {
    it("rejects empty description", () => {
      const def = makeValidDef({ description: "" });
      const errors = validateRunbook(def, "test-runbook");
      expect(
        errors.some((e) => e.field === "description" && e.message.includes("required")),
      ).toBe(true);
    });
  });

  describe("ownerAgent", () => {
    it("accepts a catalog agent as ownerAgent", () => {
      const def = makeValidDef({ ownerAgent: "build" });
      const errors = validateRunbook(def, "test-runbook");
      expect(errors.filter((e) => e.field === "ownerAgent")).toEqual([]);
    });

    it("accepts a persistent (overlay) agent as ownerAgent", () => {
      const def = makeValidDef({ ownerAgent: "db-executioner" });
      const errors = validateRunbook(def, "test-runbook");
      expect(errors.filter((e) => e.field === "ownerAgent")).toEqual([]);
    });

    it("rejects unknown ownerAgent", () => {
      const def = makeValidDef({ ownerAgent: "nonexistent-agent" });
      const errors = validateRunbook(def, "test-runbook");
      expect(
        errors.some(
          (e) => e.field === "ownerAgent" && e.message.includes("not found"),
        ),
      ).toBe(true);
    });

    it("rejects empty ownerAgent", () => {
      const def = makeValidDef({ ownerAgent: "" });
      const errors = validateRunbook(def, "test-runbook");
      expect(
        errors.some((e) => e.field === "ownerAgent" && e.message.includes("required")),
      ).toBe(true);
    });
  });

  describe("intent", () => {
    it("requires at least one intent example", () => {
      const def = makeValidDef({
        intent: { examples: [], excludes: [] },
      });
      const errors = validateRunbook(def, "test-runbook");
      expect(
        errors.some(
          (e) =>
            e.field === "intent.examples" &&
            e.message.includes("at least one"),
        ),
      ).toBe(true);
    });
  });

  describe("inputs", () => {
    it("rejects unknown input types", () => {
      const def = makeValidDef({
        inputs: [
          { name: "when", type: "date" as never, required: true },
        ],
      });
      const errors = validateRunbook(def, "test-runbook");
      expect(
        errors.some(
          (e) => e.field === "inputs[0].type" && e.message.includes("unknown input type"),
        ),
      ).toBe(true);
    });

    it("rejects enum input without enumValues", () => {
      const def = makeValidDef({
        inputs: [
          { name: "status", type: "enum", required: true },
        ],
      });
      const errors = validateRunbook(def, "test-runbook");
      expect(
        errors.some(
          (e) =>
            e.field === "inputs[0].enumValues" &&
            e.message.includes("enumValues"),
        ),
      ).toBe(true);
    });

    it("accepts enum input with enumValues", () => {
      const def = makeValidDef({
        inputs: [
          {
            name: "status",
            type: "enum",
            required: true,
            enumValues: ["active", "inactive"],
          },
        ],
      });
      const errors = validateRunbook(def, "test-runbook");
      expect(errors.filter((e) => e.field.startsWith("inputs"))).toEqual([]);
    });
  });

  describe("risk", () => {
    it("rejects unknown risk", () => {
      const def = makeValidDef({ risk: "medium" as never });
      const errors = validateRunbook(def, "test-runbook");
      expect(
        errors.some((e) => e.field === "risk" && e.message.includes("unknown risk")),
      ).toBe(true);
    });

    it("accepts all valid risk levels", () => {
      const validRisks = [
        "read-only",
        "workspace-write",
        "production-write",
        "destructive",
        "credential",
        "privacy-sensitive",
        "payment",
        "access-control",
      ] as const;

      for (const risk of validRisks) {
        const def = makeValidDef({
          risk,
          // Satisfy the constraints for high-risk and mutation
          approval: { required: true },
          verification: { required: true, assertions: ["ok"] },
        });
        const errors = validateRunbook(def, "test-runbook");
        expect(errors.filter((e) => e.field === "risk")).toEqual([]);
      }
    });
  });

  describe("high-risk approval requirement", () => {
    const highRiskKinds = [
      "production-write",
      "destructive",
      "credential",
      "privacy-sensitive",
      "payment",
      "access-control",
    ] as const;

    for (const risk of highRiskKinds) {
      it(`${risk} without approval.required = true is rejected`, () => {
        const def = makeValidDef({
          risk,
          approval: { required: false },
          verification: { required: true, assertions: ["ok"] },
        });
        const errors = validateRunbook(def, "test-runbook");
        expect(
          errors.some(
            (e) =>
              e.field === "approval.required" &&
              e.message.includes("requires approval"),
          ),
        ).toBe(true);
      });

      it(`${risk} with approval.required = true passes`, () => {
        const def = makeValidDef({
          risk,
          approval: { required: true },
          verification: { required: true, assertions: ["ok"] },
        });
        const errors = validateRunbook(def, "test-runbook");
        expect(errors.filter((e) => e.field === "approval.required")).toEqual(
          [],
        );
      });
    }
  });

  describe("mutation risk verification requirement", () => {
    it("workspace-write without verification.required is rejected", () => {
      const def = makeValidDef({
        risk: "workspace-write",
        verification: { required: false, assertions: [] },
      });
      const errors = validateRunbook(def, "test-runbook");
      expect(
        errors.some(
          (e) =>
            e.field === "verification.required" &&
            e.message.includes("mutation risk"),
        ),
      ).toBe(true);
    });

    it("read-only risk does NOT require verification", () => {
      const def = makeValidDef({
        risk: "read-only",
        verification: { required: false, assertions: [] },
        capabilities: ["mongo.read"],
      });
      const errors = validateRunbook(def, "test-runbook");
      expect(errors.filter((e) => e.field === "verification.required")).toEqual(
        [],
      );
    });
  });

  describe("capabilities", () => {
    it("rejects unknown capability bundle", () => {
      const def = makeValidDef({
        capabilities: ["mongo.read", "unknown.bundle"],
      });
      const errors = validateRunbook(def, "test-runbook");
      expect(
        errors.some(
          (e) =>
            e.field === "capabilities" &&
            e.message.includes('unknown capability bundle "unknown.bundle"'),
        ),
      ).toBe(true);
    });

    it("rejects capability widening: review agent requesting migration.execute", () => {
      const def = makeValidDef({
        ownerAgent: "review",
        capabilities: ["migration.execute"],
      });
      const errors = validateRunbook(def, "test-runbook");
      expect(
        errors.some(
          (e) =>
            e.field === "capabilities" &&
            e.message.includes("repo-write") &&
            e.message.includes("review"),
        ),
      ).toBe(true);
    });
  });

  describe("secret detection", () => {
    it("detects mongodb+srv:// in prompt", () => {
      const def = makeValidDef({
        prompt: "Connect to mongodb+srv://user:pass@host/db",
      });
      const errors = validateRunbook(def, "test-runbook");
      expect(
        errors.some(
          (e) => e.field === "content" && e.message.includes("secret pattern"),
        ),
      ).toBe(true);
    });

    it("detects Bearer token in description", () => {
      const def = makeValidDef({
        description: "Use Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 to auth",
      });
      const errors = validateRunbook(def, "test-runbook");
      expect(
        errors.some(
          (e) => e.field === "content" && e.message.includes("secret pattern"),
        ),
      ).toBe(true);
    });

    it("detects sk- key pattern", () => {
      const def = makeValidDef({
        prompt: "Use sk-1234567890abcdefghijklmnop for API",
      });
      const errors = validateRunbook(def, "test-runbook");
      expect(
        errors.some(
          (e) => e.field === "content" && e.message.includes("secret pattern"),
        ),
      ).toBe(true);
    });

    it("detects ghp_ token pattern", () => {
      const def = makeValidDef({
        prompt:
          "Token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl",
      });
      const errors = validateRunbook(def, "test-runbook");
      expect(
        errors.some(
          (e) => e.field === "content" && e.message.includes("secret pattern"),
        ),
      ).toBe(true);
    });

    it("detects gho_ token pattern", () => {
      const def = makeValidDef({
        prompt:
          "Token: gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijkl",
      });
      const errors = validateRunbook(def, "test-runbook");
      expect(
        errors.some(
          (e) => e.field === "content" && e.message.includes("secret pattern"),
        ),
      ).toBe(true);
    });

    it("detects password=xxx pattern", () => {
      const def = makeValidDef({
        prompt: "Set password=supersecret123 in config",
      });
      const errors = validateRunbook(def, "test-runbook");
      expect(
        errors.some(
          (e) => e.field === "content" && e.message.includes("secret pattern"),
        ),
      ).toBe(true);
    });
  });

  describe("prompt", () => {
    it("rejects empty prompt", () => {
      const def = makeValidDef({ prompt: "" });
      const errors = validateRunbook(def, "test-runbook");
      expect(
        errors.some(
          (e) => e.field === "prompt" && e.message.includes("required"),
        ),
      ).toBe(true);
    });
  });

  it("accumulates multiple errors (not just the first)", () => {
    const def = makeValidDef({
      schemaVersion: 99,
      name: "",
      description: "",
      ownerAgent: "",
      intent: { examples: [], excludes: [] },
      prompt: "",
    });
    const errors = validateRunbook(def, "");
    // Should have errors for at least: schemaVersion, name, description,
    // ownerAgent, intent.examples, prompt
    expect(errors.length).toBeGreaterThanOrEqual(5);

    const fields = errors.map((e) => e.field);
    expect(fields).toContain("schemaVersion");
    expect(fields).toContain("name");
    expect(fields).toContain("description");
    expect(fields).toContain("ownerAgent");
    expect(fields).toContain("intent.examples");
    expect(fields).toContain("prompt");
  });
});
