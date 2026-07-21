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
