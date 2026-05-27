import { afterEach, describe, expect, it, mock } from "bun:test";
import { readFile } from "node:fs/promises";
import { downloadSlackFiles } from "./files.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("downloadSlackFiles", () => {
  it("downloads non-image Slack files too", async () => {
    const fetchMock = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toEqual({ Authorization: "Bearer xoxb-test" });
      return new Response("name,email\nA,a@example.com\n", { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const paths = await downloadSlackFiles(
      [
        {
          url: "https://files.slack.com/files-pri/T/F/download/report.csv",
          name: "report.csv",
          mimetype: "text/csv",
        },
      ],
      "thread-files-test",
      "xoxb-test",
    );

    expect(paths).toEqual(["/tmp/junior-files/thread-files-test/report.csv"]);
    expect(await readFile(paths[0], "utf8")).toBe("name,email\nA,a@example.com\n");
  });

  it("uses the basename of Slack file names when writing locally", async () => {
    globalThis.fetch = mock(async () => new Response("safe", { status: 200 })) as unknown as typeof fetch;

    const paths = await downloadSlackFiles(
      [
        {
          url: "https://files.slack.com/files-pri/T/F/download/report.csv",
          name: "../report.csv",
          mimetype: "text/csv",
        },
      ],
      "thread-files-basename-test",
      "xoxb-test",
    );

    expect(paths).toEqual(["/tmp/junior-files/thread-files-basename-test/report.csv"]);
  });
});
