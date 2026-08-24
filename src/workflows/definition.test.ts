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
          idleTimeoutMs: 300000,
          maxIdleInterrupts: 2,
        },
      },
    });

    expect(definition.name).toBe("worklog");
    expect(definition.enabled).toBe(true);
    expect(definition.concurrency).toBe("skip");
    expect(definition.runner?.agentName).toBe("lead");
    expect(definition.runner?.idleTimeoutMs).toBe(300000);
    expect(definition.runner?.maxIdleInterrupts).toBe(2);
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

  it("binds a supported native handler explicitly without an agent runner", () => {
    const definition = validateWorkflowDefinition({
      path: "workflows/slack-archive-maintenance.workflow.md",
      sourceRoot: "public",
      repos,
      content: validContent(),
      body: "Documentation only.",
      frontmatter: {
        name: "slack-archive-maintenance",
        enabled: true,
        nativeHandler: "slack-archive-maintenance",
        ownerSlackUserIds: [],
        triggers: [{ type: "schedule", cron: "17 3 * * 0", timezone: "Asia/Kolkata" }],
        outputs: [{ type: "docs", path: "data/workflow-runs/slack-archive-maintenance" }],
        permissions: { tools: ["slack.read", "archive.write", "docs.write"] },
      },
    });

    expect(definition.nativeHandler).toBe("slack-archive-maintenance");
    expect(definition.runner).toBeUndefined();
  });

  it("accepts the report-first memory decay native handler", () => {
    const definition = validateWorkflowDefinition({
      path: "workflows/memory-decay-report.workflow.md",
      sourceRoot: "public",
      repos,
      content: validContent(),
      body: "Report only.",
      frontmatter: {
        name: "memory-decay-report",
        enabled: true,
        nativeHandler: "memory-decay-report",
        ownerSlackUserIds: [],
        triggers: [{ type: "schedule", cron: "18 6 * * 1", timezone: "Asia/Kolkata" }],
        outputs: [{ type: "docs", path: "data/workflow-runs/memory-decay-report" }],
        permissions: { tools: ["docs.write", "memory.read", "memory.write", "memory.evaluate"] },
      },
    });
    expect(definition.nativeHandler).toBe("memory-decay-report");
  });

  it("rejects unknown native handlers and native-handler plus runner ambiguity", () => {
    const base = {
      name: "worklog",
      enabled: true,
      ownerSlackUserIds: [],
      triggers: [{ type: "command", command: "worklog" }],
      outputs: [{ type: "docs", path: "data/workflow-runs/worklog" }],
      permissions: { tools: ["docs.write"] },
    };
    const validate = (frontmatter: Record<string, unknown>) =>
      validateWorkflowDefinition({
        path: "workflows/worklog.workflow.md",
        sourceRoot: "public",
        repos,
        content: validContent(),
        body: "Documentation only.",
        frontmatter,
      });

    expect(() => validate({ ...base, nativeHandler: "run-arbitrary-code" }))
      .toThrow("Unsupported nativeHandler");
    expect(() => validate({
      ...base,
      nativeHandler: "memory-dedup-sweep",
      runner: { provider: "default", agentName: "default" },
    })).toThrow("mutually exclusive");
    expect(() => validate({
      ...base,
      nativeHandler: "slack-archive-maintenance",
    })).toThrow("requires permissions: slack.read, archive.write");
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
