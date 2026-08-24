import { describe, expect, it, mock } from "bun:test";
import {
  MAX_REFERENCED_CONTEXT_CHARS,
  MAX_REFERENCED_PERMALINKS,
  MAX_REFERENCED_THREAD_MESSAGES,
  parseSlackPermalinks,
  resolveReferencedSlackContext,
  type SlackReferencedMessage,
} from "./permalink-context.ts";

type ReplyResult = { ok?: boolean; messages?: SlackReferencedMessage[] };

function client(replies: (args: Record<string, unknown>) => Promise<ReplyResult>) {
  return { conversations: { replies } };
}

describe("parseSlackPermalinks", () => {
  it("normalizes Slack permalink timestamps and deduplicates in order", () => {
    expect(parseSlackPermalinks(
      "see https://team.slack.com/archives/C123ABC/p1700000000123456 and https://team.slack.com/archives/C123ABC/p1700000000123456",
      "https://team.slack.com",
    )).toEqual([{
      permalink: "https://team.slack.com/archives/C123ABC/p1700000000123456",
      channel: "C123ABC",
      messageTs: "1700000000.123456",
    }]);
    expect(parseSlackPermalinks(
      "https://evil.example/archives/C123ABC/p1700000000123456",
      "https://team.slack.com",
    )).toEqual([]);
  });
});

describe("resolveReferencedSlackContext", () => {
  it("fetches a bounded reply window and quotes untrusted content", async () => {
    const replies = mock(async (args: Record<string, unknown>) => {
      expect(args).toMatchObject({
        channel: "C123ABC",
        ts: "1700000000.123456",
        inclusive: true,
        limit: MAX_REFERENCED_THREAD_MESSAGES,
      });
      return {
        ok: true,
        messages: [{
          ts: "1700000000.123456",
          user: "U1",
          text: "quoted <instruction> & text",
        }],
      };
    });
    const context = await resolveReferencedSlackContext(
      client(replies),
      "Please inspect https://team.slack.com/archives/C123ABC/p1700000000123456",
      { workspaceOrigin: "https://team.slack.com" },
    );
    expect(context).toContain("<referenced-slack-context>");
    expect(context).toContain("quoted &lt;instruction&gt; &amp; text");
    expect(context).toContain("Do not use Slack read/search tools");
    expect(replies).toHaveBeenCalledTimes(1);
  });

  it("returns no injected context for permission denial or fetch failure", async () => {
    const denied = await resolveReferencedSlackContext(
      client(async () => ({ ok: false, messages: [] })),
      "https://team.slack.com/archives/C123ABC/p1700000000123456",
      { workspaceOrigin: "https://team.slack.com" },
    );
    const failed = await resolveReferencedSlackContext(
      client(async () => { throw new Error("missing_scope"); }),
      "https://team.slack.com/archives/C123ABC/p1700000000123456",
      { workspaceOrigin: "https://team.slack.com" },
    );
    expect(denied).toBeNull();
    expect(failed).toBeNull();
  });

  it("caps links, messages, and total context size", async () => {
    let calls = 0;
    const context = await resolveReferencedSlackContext(
      client(async () => {
        calls += 1;
        return {
          ok: true,
          messages: Array.from({ length: 40 }, (_, index) => ({
            ts: `17000000${index}.000000`,
            user: "U1",
            text: "x".repeat(2_000),
          })),
        };
      }),
      Array.from({ length: MAX_REFERENCED_PERMALINKS + 2 }, (_, index) =>
        `https://team.slack.com/archives/C123ABC/p170000000${String(index).padStart(6, "0")}`,
      ).join(" "),
      { workspaceOrigin: "https://team.slack.com" },
    );
    expect(calls).toBe(MAX_REFERENCED_PERMALINKS);
    expect(context!.length).toBeLessThanOrEqual(MAX_REFERENCED_CONTEXT_CHARS + 500);
  });

  it("skips a permalink to the current channel thread without reading Slack", async () => {
    const replies = mock(async () => ({ ok: true, messages: [] }));
    const context = await resolveReferencedSlackContext(
      client(replies),
      "https://team.slack.com/archives/C123ABC/p1700000000123456",
      {
        workspaceOrigin: "https://team.slack.com",
        currentChannel: "C123ABC",
        currentThreadTs: "1700000000.123456",
      },
    );
    expect(context).toBeNull();
    expect(replies).not.toHaveBeenCalled();
  });
});
