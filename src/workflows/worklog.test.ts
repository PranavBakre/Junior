import { describe, expect, it } from "bun:test";
import { parseGithubSlug } from "./worklog.ts";

describe("parseGithubSlug", () => {
  it("parses GitHub remotes with dots in repo names", () => {
    expect(parseGithubSlug("git@github.com:org/site.io.git")).toBe("org/site.io");
    expect(parseGithubSlug("https://github.com/org/my.repo.git")).toBe("org/my.repo");
  });

  it("parses GitHub remotes without trailing git suffix", () => {
    expect(parseGithubSlug("git@github.com:org/repo")).toBe("org/repo");
    expect(parseGithubSlug("https://github.com/org/repo")).toBe("org/repo");
  });

  it("rejects remotes that are not owner and repo shaped", () => {
    expect(parseGithubSlug("https://github.com/org/repo/extra.git")).toBeNull();
  });
});
