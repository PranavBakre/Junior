import { describe, it, expect } from "bun:test";
import { buildWorkspaceBlock, type WorkspaceContext } from "./thread-context.ts";
import type { RepoConfig } from "../config.ts";

const repos: RepoConfig[] = [
  { name: "app-backend", path: "/repos/app-backend", defaultBase: "origin/main" },
  { name: "app-frontend", path: "/repos/app-frontend", defaultBase: "origin/main" },
];

describe("buildWorkspaceBlock", () => {
  it("returns null when no workspace and no worktreePaths", () => {
    expect(buildWorkspaceBlock(null)).toBeNull();
    expect(buildWorkspaceBlock(undefined)).toBeNull();
    expect(buildWorkspaceBlock(undefined, {})).toBeNull();
  });

  it("renders the single-repo format from a WorkspaceContext", () => {
    const ws: WorkspaceContext = {
      worktreePath: "/repos/app-backend.junior-worktrees/slack-t1",
      repoName: "app-backend",
      repoPath: "/repos/app-backend",
      branchName: "slack/t1",
    };
    const block = buildWorkspaceBlock(ws);
    expect(block).toContain("<workspace>");
    expect(block).toContain("Target repo: app-backend");
    expect(block).toContain("Worktree (your sandbox): /repos/app-backend.junior-worktrees/slack-t1");
    expect(block).toContain("Worktree branch: slack/t1");
    expect(block).toContain("</workspace>");
  });

  it("renders the multi-repo format when worktreePaths is non-empty", () => {
    const paths = {
      "app-backend": "/repos/app-backend.junior-worktrees/slack-t1",
      "app-frontend": "/repos/app-frontend.junior-worktrees/slack-t1",
    };
    const block = buildWorkspaceBlock(undefined, paths, repos, "t1");

    expect(block).toContain("<workspace>");
    expect(block).toContain("Work ONLY inside the worktree paths listed below");
    // Per-repo blocks list both the worktree (sandbox) and the bare repo (off-limits).
    expect(block).toContain("repo: app-backend");
    expect(block).toContain("worktree (your sandbox): /repos/app-backend.junior-worktrees/slack-t1");
    expect(block).toContain("bare repo (OFF-LIMITS):  /repos/app-backend");
    expect(block).toContain("branch:                 slack/t1");
    expect(block).toContain("base:                   origin/main");
    expect(block).toContain("repo: app-frontend");
    expect(block).toContain("worktree (your sandbox): /repos/app-frontend.junior-worktrees/slack-t1");
    expect(block).toContain("bare repo (OFF-LIMITS):  /repos/app-frontend");
    // Rules anchor to the listed paths.
    expect(block).toContain("RULES — non-negotiable:");
    expect(block).toContain("inside the worktree paths listed above");
    expect(block).toContain("at any bare-repo path listed above");
    expect(block).toContain("</workspace>");
  });

  it("multi-repo format ignores `workspace` when worktreePaths is non-empty", () => {
    const ws: WorkspaceContext = {
      worktreePath: "/should/not/appear",
      repoName: "should-not-appear",
      repoPath: "/should/not/appear",
      branchName: "should-not-appear",
    };
    const paths = { "app-backend": "/repos/app-backend.junior-worktrees/slack-t1" };
    const block = buildWorkspaceBlock(ws, paths, repos, "t1");

    expect(block).not.toContain("should-not-appear");
    expect(block).toContain("repo: app-backend");
  });

  it("falls back to defaults when repos config is missing", () => {
    const paths = { "app-backend": "/some/path" };
    const block = buildWorkspaceBlock(undefined, paths, undefined, "t1");

    expect(block).toContain("base:                   origin/main");
    // No bare-repo line should be emitted when repos config is missing.
    expect(block).not.toContain("bare repo (OFF-LIMITS):");
  });

  it("uses placeholder branch when threadId is missing", () => {
    const paths = { "app-backend": "/some/path" };
    const block = buildWorkspaceBlock(undefined, paths, repos);

    expect(block).toContain("branch:                 slack/<thread>");
  });
});
