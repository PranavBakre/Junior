import { describe, expect, it } from "bun:test";
import {
  collectWorklogActivity,
  parseGithubSlug,
  type RunCommand,
} from "./activity.ts";

describe("parseGithubSlug", () => {
  it("parses ssh and https GitHub remotes", () => {
    expect(parseGithubSlug("git@github.com:acme/app.git")).toBe("acme/app");
    expect(parseGithubSlug("https://github.com/acme/app.git")).toBe("acme/app");
    expect(parseGithubSlug("https://github.com/acme/app")).toBe("acme/app");
  });

  it("ignores non-GitHub remotes", () => {
    expect(parseGithubSlug("git@gitlab.com:acme/app.git")).toBeNull();
  });
});

describe("collectWorklogActivity", () => {
  it("collects commits and pull requests per configured repo", async () => {
    const runCommand: RunCommand = async (command, args) => {
      const key = `${command} ${args.join(" ")}`;
      if (key === "git config --get user.email") {
        return { exitCode: 0, stdout: "me@example.com\n", stderr: "" };
      }
      if (key.startsWith("git log ")) {
        return {
          exitCode: 0,
          stdout: "abc123\x1fabc123\x1f2026-05-21T09:00:00+05:30\x1fship event redesign\n",
          stderr: "",
        };
      }
      if (key === "git remote get-url origin") {
        return {
          exitCode: 0,
          stdout: "git@github.com:growthx/app.git\n",
          stderr: "",
        };
      }
      if (key === "gh api user --jq .login") {
        return { exitCode: 0, stdout: "pranav\n", stderr: "" };
      }
      if (key.startsWith("gh pr list ")) {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              number: 42,
              title: "Event registration redesign",
              state: "MERGED",
              url: "https://github.com/growthx/app/pull/42",
              updatedAt: "2026-05-21T09:10:00Z",
              mergedAt: "2026-05-21T09:15:00Z",
            },
          ]),
          stderr: "",
        };
      }
      return { exitCode: 1, stdout: "", stderr: `unexpected ${key}` };
    };

    const activity = await collectWorklogActivity({
      repos: [{ name: "gx-client-next", path: "/repo", defaultBase: "main" }],
      since: new Date("2026-05-20T18:00:00.000Z"),
      until: new Date("2026-05-21T18:00:00.000Z"),
      runCommand,
    });

    expect(activity.commits).toHaveLength(1);
    expect(activity.commits[0].subject).toBe("ship event redesign");
    expect(activity.prs).toHaveLength(1);
    expect(activity.prs[0].number).toBe(42);
    expect(activity.errors).toEqual([]);
  });
});
