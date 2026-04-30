import { describe, it, expect } from "bun:test";
import { buildWorkspaceBlock, type WorkspaceContext } from "./thread-context.ts";
import type { RepoConfig } from "../config.ts";

const repos: RepoConfig[] = [
  { name: "gx-backend", path: "/repos/gx-backend", defaultBase: "origin/main" },
  { name: "gx-client-next", path: "/repos/gx-client-next", defaultBase: "origin/main" },
];

describe("buildWorkspaceBlock", () => {
  it("returns null when no workspace and no worktreePaths", () => {
    expect(buildWorkspaceBlock(null)).toBeNull();
    expect(buildWorkspaceBlock(undefined)).toBeNull();
    expect(buildWorkspaceBlock(undefined, {})).toBeNull();
  });

  it("renders the single-repo format from a WorkspaceContext", () => {
    const ws: WorkspaceContext = {
      worktreePath: "/repos/gx-backend/.claude/worktrees/slack-t1",
      repoName: "gx-backend",
      repoPath: "/repos/gx-backend",
      branchName: "slack/t1",
    };
    const block = buildWorkspaceBlock(ws);
    expect(block).toContain("<workspace>");
    expect(block).toContain("Target repo: gx-backend");
    expect(block).toContain("Worktree (your sandbox): /repos/gx-backend/.claude/worktrees/slack-t1");
    expect(block).toContain("Worktree branch: slack/t1");
    expect(block).toContain("</workspace>");
  });

  it("renders the multi-repo format when worktreePaths is non-empty", () => {
    const paths = {
      "gx-backend": "/repos/gx-backend/.claude/worktrees/slack-t1",
      "gx-client-next": "/repos/gx-client-next/.claude/worktrees/slack-t1",
    };
    const block = buildWorkspaceBlock(undefined, paths, repos, "t1");

    expect(block).toContain("<workspace>");
    expect(block).toContain("ALWAYS use these paths");
    expect(block).toContain("NEVER touch");
    expect(block).toContain("~/openclaw-projects/");
    expect(block).toContain("repo: gx-backend");
    expect(block).toContain("worktree: /repos/gx-backend/.claude/worktrees/slack-t1");
    expect(block).toContain("branch:   slack/t1");
    expect(block).toContain("base:     origin/main");
    expect(block).toContain("repo: gx-client-next");
    expect(block).toContain("worktree: /repos/gx-client-next/.claude/worktrees/slack-t1");
    expect(block).toContain("</workspace>");
  });

  it("multi-repo format ignores `workspace` when worktreePaths is non-empty", () => {
    const ws: WorkspaceContext = {
      worktreePath: "/should/not/appear",
      repoName: "should-not-appear",
      repoPath: "/should/not/appear",
      branchName: "should-not-appear",
    };
    const paths = { "gx-backend": "/repos/gx-backend/.claude/worktrees/slack-t1" };
    const block = buildWorkspaceBlock(ws, paths, repos, "t1");

    expect(block).not.toContain("should-not-appear");
    expect(block).toContain("repo: gx-backend");
  });

  it("falls back to defaults when repos config is missing", () => {
    const paths = { "gx-backend": "/some/path" };
    const block = buildWorkspaceBlock(undefined, paths, undefined, "t1");

    expect(block).toContain("base:     origin/main");
  });

  it("uses placeholder branch when threadId is missing", () => {
    const paths = { "gx-backend": "/some/path" };
    const block = buildWorkspaceBlock(undefined, paths, repos);

    expect(block).toContain("branch:   slack/<thread>");
  });
});
