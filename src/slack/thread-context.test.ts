import { describe, it, expect } from "bun:test";
import {
  buildPromptPreamble,
  buildWorkspaceBlock,
  resolveSlackMentions,
  type WorkspaceContext,
} from "./thread-context.ts";
import type { App } from "@slack/bolt";
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
    // Rule 3: cd prohibition. Rule 4: devserver prohibition.
    expect(block).toContain("NEVER `cd` out of your worktree");
    expect(block).toContain("NEVER run dev servers yourself");
    expect(block).toContain("`!devserver <branch>`");
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

describe("buildPromptPreamble", () => {
  it("labels self mentions distinctly when other users are tagged too", async () => {
    const app = {
      client: {
        users: {
          info: async ({ user }: { user: string }) => ({
            user: { profile: { display_name: user === "UBOT" ? "junior" : "alex" } },
          }),
        },
      },
    } as unknown as App;

    const text = await resolveSlackMentions(
      app,
      "<@UBOT> <@UALEX> can you check this?",
      "UBOT",
    );

    expect(text).toBe(
      "Junior (you <@UBOT>) User(alex <@UALEX>) can you check this?",
    );
  });

  it("uses the per-agent thread history limit", async () => {
    let observedLimit: number | undefined;
    const app = {
      client: {
        conversations: {
          replies: async (args: { limit?: number }) => {
            observedLimit = args.limit;
            return { messages: [{ ts: "1", user: "U1", text: "root" }] };
          },
        },
      },
    } as unknown as App;

    await buildPromptPreamble(
      app,
      "C1",
      "1",
      "2",
      "UBOT",
      null,
      undefined,
      undefined,
      {
        identity: false,
        slack: false,
        workspace: false,
        threadHistory: true,
        threadHistoryLimit: 12,
        agentState: false,
      },
    );

    expect(observedLimit).toBe(12);
  });

  it("includes previous thread messages but filters !aside messages", async () => {
    const app = {
      client: {
        users: {
          info: async ({ user }: { user: string }) => ({
            user: { profile: { display_name: user } },
          }),
        },
        conversations: {
          replies: async () => ({
            messages: [
              { ts: "1", user: "U1", text: "root message" },
              { ts: "2", user: "U2", text: "dormant detail to keep" },
              { ts: "3", user: "U3", text: "!aside private aside" },
              { ts: "4", user: "U4", text: "!aside. punctuated private aside" },
              { ts: "5", user: "U5", text: "current message" },
            ],
          }),
        },
      },
    } as unknown as App;

    const preamble = await buildPromptPreamble(
      app,
      "C1",
      "1",
      "5",
      "UBOT",
      null,
      undefined,
      undefined,
      {
        identity: false,
        slack: false,
        workspace: false,
        threadHistory: true,
        threadHistoryLimit: 100,
        agentState: false,
      },
    );

    expect(preamble).toContain("root message");
    expect(preamble).toContain("dormant detail to keep");
    expect(preamble).not.toContain("private aside");
    expect(preamble).not.toContain("User(U5 <@U5>): current message");
  });

  it("labels historical attachments as shared files", async () => {
    const app = {
      client: {
        users: {
          info: async ({ user }: { user: string }) => ({
            user: { profile: { display_name: user } },
          }),
        },
        conversations: {
          replies: async () => ({
            messages: [
              { ts: "1", user: "U1", text: "root message" },
              {
                ts: "2",
                user: "U2",
                text: "see attached",
                files: [{ name: "assignments.csv" }],
              },
              { ts: "3", user: "U3", text: "current message" },
            ],
          }),
        },
      },
    } as unknown as App;

    const preamble = await buildPromptPreamble(
      app,
      "C1",
      "1",
      "3",
      "UBOT",
      null,
      undefined,
      undefined,
      {
        identity: false,
        slack: false,
        workspace: false,
        threadHistory: true,
        threadHistoryLimit: 100,
        agentState: false,
      },
    );

    expect(preamble).toContain("[shared file: assignments.csv]");
  });
});
