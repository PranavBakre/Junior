import { describe, expect, it } from "bun:test";
import type { RepoConfig } from "../config.ts";
import {
  inferPipelinePrimaryRepo,
  resolvePipelineRepos,
} from "./pipeline-routing.ts";

const repos: RepoConfig[] = [
  {
    name: "gx-backend",
    path: "/repos/gx-backend",
    defaultBase: "origin/main",
  },
  {
    name: "gx-admin-client",
    path: "/repos/gx-admin-client",
    defaultBase: "origin/main",
  },
];

describe("pipeline worktree routing", () => {
  it("resolves repo refs in durable run order and reports unknown refs", () => {
    expect(
      resolvePipelineRepos(repos, [
        "GrowthX-Club/gx-admin-client",
        "gx-backend",
        "GrowthX-Club/not-configured",
        "GrowthX-Club/not-configured",
        "gx-admin-client",
      ]),
    ).toEqual({
      repos: [repos[1], repos[0]],
      unresolvedRefs: ["GrowthX-Club/not-configured"],
    });
  });

  it("routes frontend and backend workstreams to their own repo", () => {
    expect(
      inferPipelinePrimaryRepo({
        configuredRepos: repos,
        pipelineRepos: repos,
        prompt: "implement the assigned stream",
        targetAgent: "build",
        assignmentContextRefs: ["workstream:frontend"],
      })?.name,
    ).toBe("gx-admin-client");

    expect(
      inferPipelinePrimaryRepo({
        configuredRepos: repos,
        pipelineRepos: repos,
        prompt: "implement the assigned stream",
        targetAgent: "build",
        assignmentContextRefs: ["workstream:backend"],
      })?.name,
    ).toBe("gx-backend");
  });

  it("does not let an incidental PR URL override a build workstream", () => {
    expect(
      inferPipelinePrimaryRepo({
        configuredRepos: repos,
        pipelineRepos: repos,
        prompt:
          "fix the backend while preserving context from https://github.com/GrowthX-Club/gx-admin-client/pull/42",
        targetAgent: "build",
        assignmentContextRefs: ["workstream:backend"],
      })?.name,
    ).toBe("gx-backend");
  });

  it("reports ambiguous affinities before falling back to durable repo order", () => {
    const diagnostics: string[] = [];
    const selected = inferPipelinePrimaryRepo({
      configuredRepos: repos,
      pipelineRepos: [repos[1]!, repos[0]!],
      prompt: "coordinate both streams",
      targetAgent: "build",
      assignmentContextRefs: ["workstream:frontend", "workstream:backend"],
      onDiagnostic: (message) => diagnostics.push(message),
    });

    expect(selected?.name).toBe("gx-admin-client");
    expect(diagnostics).toEqual([
      "multiple assignment workstreams (frontend, backend); falling back to durable repo order",
      "no unique repo affinity for a multi-repo pipeline; falling back to durable repo order",
    ]);
  });

  it("reports a missing workstream match before falling back", () => {
    const diagnostics: string[] = [];
    const selected = inferPipelinePrimaryRepo({
      configuredRepos: repos,
      pipelineRepos: repos,
      prompt: "implement the mobile stream",
      targetAgent: "build",
      assignmentContextRefs: ["workstream:mobile"],
      onDiagnostic: (message) => diagnostics.push(message),
    });

    expect(selected?.name).toBe("gx-backend");
    expect(diagnostics).toEqual([
      "no pipeline repo matches mobile affinity; falling back to durable repo order",
    ]);
  });

  it("lets an explicit PR URL choose the initial worktree", () => {
    expect(
      inferPipelinePrimaryRepo({
        configuredRepos: repos,
        pipelineRepos: repos,
        prompt:
          "review https://github.com/GrowthX-Club/gx-admin-client/pull/42",
        targetAgent: "review",
      })?.name,
    ).toBe("gx-admin-client");
  });
});
