import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import path from "node:path";
import fs from "node:fs/promises";
import { loadRunbookDefinition } from "./loader.ts";
import {
  AGENT_IDENTITIES,
  registerAgentIdentity,
} from "../support/agents.ts";

const fixtureDir = path.join(import.meta.dir, "__fixtures__");
const fixturePath = path.join(fixtureDir, "transfer-ai-roadmaps.runbook.md");
const tmpDir = path.join(import.meta.dir, "__loader_test");

describe("loadRunbookDefinition", () => {
  beforeEach(() => {
    registerAgentIdentity("db-executioner", {
      username: "DB Executioner",
      iconEmoji: ":database:",
    });
  });

  afterEach(async () => {
    delete AGENT_IDENTITIES["db-executioner"];
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("loads a valid runbook from the fixture with correct types", async () => {
    const result = await loadRunbookDefinition(fixturePath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const def = result.definition;
    expect(def.schemaVersion).toBe(1);
    expect(def.name).toBe("transfer-ai-roadmaps");
    expect(def.description).toBe(
      "Transfer every AI roadmap owned by one user to another user.",
    );
    expect(def.ownerAgent).toBe("db-executioner");
    expect(def.risk).toBe("production-write");
    expect(def.approval.required).toBe(true);
    expect(def.verification.required).toBe(true);
    expect(def.origin).toBe("private");
    expect(def.filePath).toBe(fixturePath);
    expect(def.prompt).toBeTruthy();
    expect(def.tags).toEqual(["database", "ai-roadmaps"]);
  });

  it("returns ok: false for a missing file", async () => {
    const result = await loadRunbookDefinition("/nonexistent/path.runbook.md");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].field).toBe("file");
    expect(result.errors[0].message).toContain("file not found");
  });

  it("returns error for missing frontmatter", async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    const noFmPath = path.join(tmpDir, "no-fm.runbook.md");
    await Bun.write(noFmPath, "Just some content without frontmatter.");

    const result = await loadRunbookDefinition(noFmPath);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.field === "frontmatter")).toBe(true);
  });

  it("produces a stable content digest for the same file", async () => {
    const r1 = await loadRunbookDefinition(fixturePath);
    const r2 = await loadRunbookDefinition(fixturePath);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.definition.contentDigest).toBe(r2.definition.contentDigest);
    // Must be a hex string
    expect(r1.definition.contentDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("digest changes when content changes", async () => {
    await fs.mkdir(tmpDir, { recursive: true });

    const content1 = `---
schemaVersion: 1
name: digest-test
description: Digest test version 1
ownerAgent: build
intent:
  examples:
    - do thing one
risk: workspace-write
approval:
  required: false
capabilities:
  - mongo.read
verification:
  required: true
  assertions:
    - thing was done
tags:
  - test
---

Do version one.`;

    const content2 = `---
schemaVersion: 1
name: digest-test
description: Digest test version 2
ownerAgent: build
intent:
  examples:
    - do thing one
risk: workspace-write
approval:
  required: false
capabilities:
  - mongo.read
verification:
  required: true
  assertions:
    - thing was done
tags:
  - test
---

Do version two.`;

    const p1 = path.join(tmpDir, "digest-test.runbook.md");
    await Bun.write(p1, content1);
    const r1 = await loadRunbookDefinition(p1);

    await Bun.write(p1, content2);
    const r2 = await loadRunbookDefinition(p1);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect(r1.definition.contentDigest).not.toBe(
      r2.definition.contentDigest,
    );
  });

  it("parses all YAML structures from the fixture correctly", async () => {
    const result = await loadRunbookDefinition(fixturePath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const def = result.definition;

    // Scalar values
    expect(typeof def.schemaVersion).toBe("number");
    expect(typeof def.name).toBe("string");
    expect(typeof def.description).toBe("string");

    // Arrays of scalars
    expect(def.intent.examples).toBeArray();
    expect(def.intent.examples.length).toBeGreaterThanOrEqual(2);
    expect(def.intent.excludes).toBeArray();
    expect(def.intent.excludes.length).toBeGreaterThanOrEqual(1);
    expect(def.tags).toBeArray();
    expect(def.capabilities).toBeArray();

    // Nested objects
    expect(typeof def.approval.required).toBe("boolean");
    expect(def.approval.afterSteps).toBeArray();

    // Arrays of objects (inputs)
    expect(def.inputs).toBeArray();
    expect(def.inputs.length).toBe(2);
    expect(def.inputs[0].name).toBe("sourceEmail");
    expect(def.inputs[0].type).toBe("email");
    expect(def.inputs[0].required).toBe(true);
    expect(def.inputs[0].description).toBe(
      "Email of the current roadmap owner",
    );
    expect(def.inputs[1].name).toBe("targetEmail");
    expect(def.inputs[1].type).toBe("email");
  });

  it("unquotes quoted string values in frontmatter", async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    const quotedPath = path.join(tmpDir, "quoted-test.runbook.md");
    await Bun.write(
      quotedPath,
      `---
schemaVersion: 1
name: "quoted-test"
description: 'A quoted description'
ownerAgent: build
intent:
  examples:
    - "do a quoted thing"
risk: workspace-write
approval:
  required: false
capabilities:
  - mongo.read
verification:
  required: true
  assertions:
    - thing was done
tags:
  - test
---

Do the test thing.`,
    );

    const result = await loadRunbookDefinition(quotedPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.name).toBe("quoted-test");
    expect(result.definition.description).toBe("A quoted description");
  });

  it("parses boolean values correctly", async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    const boolPath = path.join(tmpDir, "bool-test.runbook.md");
    await Bun.write(
      boolPath,
      `---
schemaVersion: 1
name: bool-test
description: Boolean test
ownerAgent: build
intent:
  examples:
    - do a bool thing
risk: production-write
approval:
  required: true
capabilities:
  - mongo.read
verification:
  required: true
  assertions:
    - thing was done
tags:
  - test
---

Do the test.`,
    );

    const result = await loadRunbookDefinition(boolPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.approval.required).toBe(true);
    expect(result.definition.verification.required).toBe(true);
  });

  it("parses number values correctly", async () => {
    const result = await loadRunbookDefinition(fixturePath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.schemaVersion).toBe(1);
    expect(typeof result.definition.schemaVersion).toBe("number");
  });

  it("respects the origin option", async () => {
    const result = await loadRunbookDefinition(fixturePath, {
      origin: "public",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.origin).toBe("public");
  });

  it("respects filenameForValidation option", async () => {
    // The fixture name is "transfer-ai-roadmaps" which matches its file.
    // Giving a mismatched filenameForValidation should cause a validation error.
    const result = await loadRunbookDefinition(fixturePath, {
      filenameForValidation: "wrong-name",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.errors.some((e) => e.field === "name" && e.message.includes("does not match")),
    ).toBe(true);
  });

  it("extracts prompt body as trimmed content after frontmatter", async () => {
    const result = await loadRunbookDefinition(fixturePath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.prompt).toContain("Resolve the source");
    expect(result.definition.prompt).not.toContain("---");
    expect(result.definition.prompt).not.toContain("schemaVersion");
  });
});
