import { describe, expect, it } from "bun:test";
import type { WebClient } from "@slack/web-api";
import type { SlackMessageEvent } from "../slack/events.ts";
import { WorkflowController } from "./controller.ts";
import type { WorkflowRegistry } from "./registry.ts";
import type { WorkflowScheduler } from "./scheduler.ts";
import { InMemoryWorkflowStore } from "./store.ts";
import type { WorkflowDefinition } from "./types.ts";

const definition: WorkflowDefinition = {
  name: "worktree-prune",
  enabled: true,
  ownerSlackUserIds: ["U123"],
  triggers: [{ type: "command", command: "worktree-prune" }],
  outputs: [{ type: "docs", path: "data/workflow-runs/worktree-prune" }],
  permissions: { tools: ["docs.write"] },
  concurrency: "skip",
  prompt: "Prune safe worktrees.",
  versionHash: "1234567890abcdef",
  sourcePath: "workflows/worktree-prune.workflow.md",
  sourceRoot: "public",
};

function event(overrides: Partial<SlackMessageEvent>): SlackMessageEvent {
  return {
    threadId: "111.222",
    channel: "C123",
    user: "U123",
    text: "",
    ts: "111.222",
    command: null,
    ...overrides,
  };
}

function harness() {
  const runs: Array<Record<string, unknown>> = [];
  const scheduler = {
    runNow: async (request: Record<string, unknown>) => {
      runs.push(request);
      return { summary: "done", runId: "run-1" };
    },
  } as unknown as WorkflowScheduler;
  const registry = {
    all: () => [definition],
    get: (name: string) => name === definition.name ? definition : undefined,
  } as unknown as WorkflowRegistry;
  const slackClient = {
    chat: { postMessage: async () => ({ ok: true }) },
    reactions: { add: async () => ({ ok: true }) },
  } as unknown as WebClient;
  return {
    runs,
    controller: new WorkflowController({
      registry,
      store: new InMemoryWorkflowStore(),
      scheduler,
      slackClient,
      isAdmin: async () => false,
    }),
  };
}

describe("WorkflowController operator instructions", () => {
  it("passes text after a custom workflow command as scoped instructions", async () => {
    const { controller, runs } = harness();

    expect(await controller.handleMessage(event({
      text: "!worktree-prune   only merged branches from widgets  ",
    }))).toBe(true);

    expect(runs).toEqual([{
      name: "worktree-prune",
      reason: "command",
      actorSlackUserId: "U123",
      instructions: "only merged branches from widgets",
    }]);
  });

  it("passes text after !workflow run <name> and leaves other actions unscoped", async () => {
    const { controller, runs } = harness();

    await controller.handleMessage(event({
      command: "workflow",
      text: "run worktree-prune only the named branch",
    }));

    expect(runs[0]).toMatchObject({
      name: "worktree-prune",
      reason: "manual",
      instructions: "only the named branch",
    });
  });
});
