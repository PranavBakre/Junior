import { describe, expect, it } from "bun:test";
import {
  cleanupThreadWorktrees,
  resolveDispatchAgent,
  shouldBypassDefaultRun,
  unsafeCleanupReason,
} from "./action-buttons.ts";
import type { WorktreeStatus } from "../worktree/manager.ts";
import type { SessionManager } from "../session/manager.ts";
import type { WorktreeManager } from "../worktree/manager.ts";
import { createSession } from "../session/types.ts";

describe("resolveDispatchAgent", () => {
  it("routes review make-fix to default outside support channels", () => {
    expect(
      resolveDispatchAgent(
        {
          channelId: "C-JUNIOR",
          action: {
            id: "review:make-fix",
            label: "Make fix",
            type: "dispatch_agent",
            agent: "thinker",
            prompt: "fix it",
          },
        },
        new Set(["C-BUGS"]),
      ),
    ).toBe("default");
  });

  it("routes review make-fix to Junior in support channels", () => {
    expect(
      resolveDispatchAgent(
        {
          channelId: "C-BUGS",
          action: {
            id: "review:make-fix",
            label: "Make fix",
            type: "dispatch_agent",
            agent: "default",
            prompt: "fix it",
          },
        },
        new Set(["C-BUGS"]),
      ),
    ).toBe("default");
  });

  it("routes review merge actions with the retired lead identity to default", () => {
    expect(
      resolveDispatchAgent(
        {
          channelId: "C-JUNIOR",
          action: {
            id: "review:merge-gxt-admin",
            label: "Merge via gxt-admin",
            type: "dispatch_agent",
            agent: "lead",
            prompt: "merge the review-approved PR",
          },
        },
        new Set(["C-BUGS"]),
      ),
    ).toBe("default");
  });

  it("leaves other dispatch actions unchanged", () => {
    expect(
      resolveDispatchAgent(
        {
          channelId: "C-JUNIOR",
          action: {
            id: "review:rereview",
            label: "Re-review",
            type: "dispatch_agent",
            agent: "review",
            prompt: "review again",
          },
        },
        new Set(["C-BUGS"]),
      ),
    ).toBe("review");
  });
});

describe("shouldBypassDefaultRun", () => {
  it("keeps Re-review from creating a second default run", () => {
    expect(
      shouldBypassDefaultRun({
        id: "review:rereview",
        label: "Re-review",
        type: "dispatch_agent",
        agent: "review",
        prompt: "review again",
      }),
    ).toBe(true);
  });

  it("keeps Make fix on the durable default-run path", () => {
    expect(
      shouldBypassDefaultRun({
        id: "review:make-fix",
        label: "Make fix",
        type: "dispatch_agent",
        agent: "default",
        prompt: "fix it",
      }),
    ).toBe(false);
  });
});

describe("unsafeCleanupReason", () => {
  it("refuses ignored dotenv files and never includes their multiline contents", () => {
    const secret = "API_KEY=one\nPRIVATE_KEY=two\n";
    const status: WorktreeStatus = {
      tracked: [],
      untracked: [],
      ignoredDotenv: [".env.local"],
      unpushedCommits: 0,
      unpushedBase: "origin/main",
    };

    const reason = unsafeCleanupReason(status);

    expect(reason).toContain("ignored dotenv files present (.env.local)");
    expect(reason).not.toContain(secret);
  });

  it("continues to allow unrelated ignored-file state", () => {
    const status: WorktreeStatus = {
      tracked: [],
      untracked: [],
      ignoredDotenv: [],
      unpushedCommits: 0,
      unpushedBase: "origin/main",
    };

    expect(unsafeCleanupReason(status)).toBeNull();
  });

  it("does not call removeWorktree when cleanup discovers ignored dotenv state", async () => {
    const session = createSession("thread-env", "C123");
    session.targetRepo = "backend";
    session.worktreePath = "/tmp/backend.junior-worktrees/slack-thread-env";
    session.worktreePaths = { backend: session.worktreePath };
    let removed = false;
    const status: WorktreeStatus = {
      tracked: [],
      untracked: [],
      ignoredDotenv: [".env.local"],
      unpushedCommits: 0,
      unpushedBase: "origin/main",
    };
    const sessionManager = {
      getSession: async () => session,
      updateSession: async () => undefined,
    } as unknown as SessionManager;
    const worktreeManager = {
      getWorktreeStatus: async () => status,
      removeWorktree: async () => { removed = true; },
    } as unknown as WorktreeManager;

    const result = await cleanupThreadWorktrees(
      session.threadId,
      sessionManager,
      worktreeManager,
    );

    expect(result).toContain("ignored dotenv files present (.env.local)");
    expect(removed).toBe(false);
  });
});
