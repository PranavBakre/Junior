import { describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { InMemoryPipelineStore } from "./store/memory.ts";
import {
  makeAssignmentCreate,
  makeProductRun,
} from "./store/test-helpers.ts";
import {
  pipelineWriteArtifact,
  type PipelineToolRuntime,
  type ToolTextResult,
} from "./tools.ts";

function body(result: ToolTextResult): Record<string, unknown> {
  return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, unknown>;
}

describe("pipeline_write_artifact authorization", () => {
  it("allows onboard-member to write its own assignment artifact", async () => {
    const store = new InMemoryPipelineStore();
    const runId = `run-onboard-artifact-${crypto.randomUUID()}`;
    const assignmentId = `assignment-onboard-${crypto.randomUUID()}`;
    const foreignAssignmentId =
      `assignment-onboard-foreign-${crypto.randomUUID()}`;
    const run = makeProductRun({
      id: runId,
      channelId: "C-ONBOARD",
      threadId: "1700000000.100",
      ownerAgent: "default",
    });
    await store.createRun(run);
    await store.createAssignment(makeAssignmentCreate({
      id: assignmentId,
      runId,
      targetAgent: "onboard-member",
    }));
    const runtime: PipelineToolRuntime = {
      store,
      runtimeMode: "active",
      githubTrackingEnabled: false,
    };
    const artifactRoot = `data/pipelines/${runId}`;

    try {
      const result = body(await pipelineWriteArtifact(runtime, {
        agent: "onboard-member",
        channel: run.channelId,
        threadId: run.threadId,
        messageTs: "1700000000.101",
        runId,
        assignmentId,
        dispatchKey: "onboard-artifact",
        signed: true,
      }, {
        run_id: runId,
        assignment_id: assignmentId,
        path: "onboarding-packet.md",
        content: "# approved packet\n",
      }));

      expect(result.ok).toBe(true);
      expect(result.artifactRef).toBe(
        `${artifactRoot}/onboarding-packet.md`,
      );

      const foreign = body(await pipelineWriteArtifact(runtime, {
        agent: "onboard-member",
        channel: run.channelId,
        threadId: run.threadId,
        messageTs: "1700000000.101",
        runId,
        assignmentId: foreignAssignmentId,
        dispatchKey: "onboard-artifact",
        signed: true,
      }, {
        run_id: runId,
        assignment_id: assignmentId,
        path: "foreign.md",
        content: "must not be written\n",
      }));
      expect(foreign.ok).toBe(false);
      expect(foreign.reason).toBe(
        "assignment does not match authenticated assignment context",
      );
    } finally {
      rmSync(resolve(process.cwd(), artifactRoot), {
        recursive: true,
        force: true,
      });
    }
  });
});
