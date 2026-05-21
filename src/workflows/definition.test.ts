import { describe, expect, it } from "bun:test";
import { validateWorkflowDefinition } from "./definition.ts";

const repos = [{ name: "junior", path: "/tmp/junior", defaultBase: "main" }];

describe("validateWorkflowDefinition", () => {
  it("accepts a valid workflow schema", () => {
    const definition = validateWorkflowDefinition({
      path: "workflows/worklog.workflow.md",
      sourceRoot: "public",
      repos,
      content: validContent(),
      body: "Summarize my work.",
      builtInCommands: new Set(["help"]),
      frontmatter: {
        name: "worklog",
        enabled: true,
        ownerSlackUserIds: ["U123ABC"],
        triggers: [
          { type: "schedule", cron: "0 18 * * 1-5", timezone: "Asia/Kolkata" },
          { type: "command", command: "worklog" },
        ],
        outputs: [
          { type: "docs", path: "data/workflow-runs/worklog" },
          { type: "slack", channel: "C123ABC" },
        ],
        permissions: {
          repos: ["junior"],
          tools: ["git", "gh", "docs.write", "slack.post"],
        },
        runner: {
          provider: "default",
          agentName: "lead",
          timeoutMs: 1000,
        },
      },
    });

    expect(definition.name).toBe("worklog");
    expect(definition.enabled).toBe(true);
    expect(definition.concurrency).toBe("skip");
    expect(definition.runner?.agentName).toBe("lead");
    expect(definition.fallback).toBeUndefined();
    expect(definition.versionHash).toHaveLength(16);
  });

  it("rejects built-in command collisions", () => {
    expect(() =>
      validateWorkflowDefinition({
        path: "workflows/worklog.workflow.md",
        sourceRoot: "public",
        repos,
        content: validContent(),
        body: "Summarize my work.",
        builtInCommands: new Set(["status"]),
        frontmatter: {
          name: "worklog",
          enabled: true,
          ownerSlackUserIds: ["U123ABC"],
          triggers: [{ type: "command", command: "status" }],
          outputs: [{ type: "docs", path: "data/workflow-runs/worklog" }],
          permissions: {
            repos: ["junior"],
            tools: ["docs.write"],
          },
        },
      }),
    ).toThrow("collides with built-in command");
  });

  it("rejects docs output paths outside the workflow artifact root", () => {
    expect(() =>
      validateWorkflowDefinition({
        path: "workflows/worklog.workflow.md",
        sourceRoot: "public",
        repos,
        content: validContent(),
        body: "Summarize my work.",
        frontmatter: {
          name: "worklog",
          enabled: true,
          ownerSlackUserIds: ["U123ABC"],
          triggers: [{ type: "command", command: "worklog" }],
          outputs: [{ type: "docs", path: "docs/workflows/worklog" }],
          permissions: {
            repos: ["junior"],
            tools: ["docs.write"],
          },
        },
      }),
    ).toThrow("docs output path must stay under data/workflow-runs/worklog");
  });

  it("rejects docs output path traversal", () => {
    expect(() =>
      validateWorkflowDefinition({
        path: "workflows/worklog.workflow.md",
        sourceRoot: "public",
        repos,
        content: validContent(),
        body: "Summarize my work.",
        frontmatter: {
          name: "worklog",
          enabled: true,
          ownerSlackUserIds: ["U123ABC"],
          triggers: [{ type: "command", command: "worklog" }],
          outputs: [{ type: "docs", path: "data/workflow-runs/worklog/../../../secrets" }],
          permissions: {
            repos: ["junior"],
            tools: ["docs.write"],
          },
        },
      }),
    ).toThrow("docs output path must stay under data/workflow-runs/worklog");
  });

  it("allows admin-only workflows with no owner IDs", () => {
    const definition = validateWorkflowDefinition({
      path: "workflows/worklog.workflow.md",
      sourceRoot: "public",
      repos,
      content: validContent(),
      body: "Summarize my work.",
      frontmatter: {
        name: "worklog",
        enabled: true,
        ownerSlackUserIds: [],
        triggers: [{ type: "command", command: "worklog" }],
        outputs: [{ type: "docs", path: "data/workflow-runs/worklog" }],
        permissions: {
          tools: ["docs.write"],
        },
      },
    });

    expect(definition.ownerSlackUserIds).toEqual([]);
    expect(definition.permissions.repos).toBeUndefined();
  });
});

function validContent(): string {
  return [
    "---",
    "name: worklog",
    "enabled: true",
    "---",
    "Summarize my work.",
  ].join("\n");
}
