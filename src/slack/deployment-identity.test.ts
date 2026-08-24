import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareSlackDeploymentIdentity,
  expectedSlackDeploymentIdentity,
  fetchSlackDeploymentIdentity,
  loadExpectedSlackDeploymentIdentity,
  persistExpectedSlackDeploymentIdentity,
} from "./deployment-identity.ts";

describe("Slack deployment identity", () => {
  it("authenticates the token, resolves visible name, and paginates joined channels", async () => {
    const calls: string[] = [];
    const client = {
      auth: { test: async () => ({ user_id: "Ubot", bot_id: "Bbot", team_id: "Tteam" }) },
      users: {
        info: async ({ user }: { user: string }) => {
          calls.push(`user:${user}`);
          return { user: { profile: { display_name: "Junior" }, real_name: "Junior Bot" } };
        },
      },
      conversations: {
        list: async ({ cursor }: { cursor?: string }) => {
          calls.push(`channels:${cursor ?? ""}`);
          return cursor
            ? { channels: [{ id: "C-private", is_member: true }], response_metadata: { next_cursor: "" } }
            : { channels: [{ id: "C-public", is_member: true }, { id: "C-other", is_member: false }], response_metadata: { next_cursor: "next" } };
        },
      },
    };

    await expect(fetchSlackDeploymentIdentity(client)).resolves.toEqual({
      userId: "Ubot",
      botId: "Bbot",
      teamId: "Tteam",
      workspaceUrl: null,
      visibleName: "Junior",
      joinedChannelIds: ["C-private", "C-public"],
    });
    expect(calls).toEqual(["user:Ubot", "channels:", "channels:next"]);
  });

  it("fails closed on identity, visible-name, and joined-channel mismatches", () => {
    const check = compareSlackDeploymentIdentity(
      {
        userId: "Uactual",
        botId: "Bactual",
        teamId: "Tactual",
        workspaceUrl: null,
        visibleName: "Other App",
        joinedChannelIds: ["C-safe"],
      },
      {
        userId: "Uexpected",
        botId: "Bexpected",
        teamId: "Texpected",
        visibleName: "Junior",
        joinedChannelIds: ["C-required"],
      },
    );
    expect(check.errors).toHaveLength(5);
    expect(check.errors.join("; ")).toContain("user_id mismatch");
    expect(check.errors.join("; ")).toContain("not joined");
  });

  it("merges explicit config over persisted identity and persists mode-0600 JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "junior-slack-identity-"));
    const path = join(dir, "identity.json");
    persistExpectedSlackDeploymentIdentity(
      { userId: "Uold", visibleName: "Old", joinedChannelIds: ["C1"] },
      path,
    );
    const persisted = loadExpectedSlackDeploymentIdentity(path);
    expect(persisted?.userId).toBe("Uold");
    const merged = expectedSlackDeploymentIdentity(
      { expectedUserId: "Unew", expectedVisibleName: "New", expectedChannelIds: ["C2"] },
      persisted,
    );
    expect(merged).toEqual({ userId: "Unew", visibleName: "New", joinedChannelIds: ["C2"] });
    expect(JSON.parse(readFileSync(path, "utf8")).userId).toBe("Uold");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
