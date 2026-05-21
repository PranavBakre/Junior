import { describe, expect, it } from "bun:test";
import { formatWorklogSlackSummary } from "./summary.ts";
import type { WorklogActivity } from "./activity.ts";

describe("formatWorklogSlackSummary", () => {
  it("groups PRs and commits by repo in Slack mrkdwn", () => {
    const activity: WorklogActivity = {
      generatedAt: "2026-05-21T12:00:00.000Z",
      since: "2026-05-20T12:00:00.000Z",
      until: "2026-05-21T12:00:00.000Z",
      repos: ["event-registration", "member-connect"],
      prs: [
        {
          repo: "event-registration",
          number: 7,
          title: "New redesign is live",
          state: "MERGED",
          url: "https://example.com/pr/7",
          updatedAt: "2026-05-21T10:00:00.000Z",
          mergedAt: "2026-05-21T10:00:00.000Z",
        },
      ],
      commits: [
        {
          repo: "member-connect",
          hash: "abcdef",
          shortHash: "abc123",
          date: "2026-05-21T09:00:00+05:30",
          subject: "continue core flows iteration",
        },
      ],
      errors: [],
    };

    const summary = formatWorklogSlackSummary(activity);

    expect(summary).toContain("> Event Registration");
    expect(summary).toContain("- New redesign is live (merged PR #7) :white_check_mark:");
    expect(summary).toContain("> Member Connect");
    expect(summary).toContain("continue core flows iteration (abc123)");
  });
});
