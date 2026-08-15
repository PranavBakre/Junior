import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";

describe("dashboard resume commands", () => {
  it("uses the CLI that owns each provider session", async () => {
    const html = await Bun.file(resolve(import.meta.dirname, "../../public/js/threads.js")).text();
    const source = html.match(/function resumeCmd\(provider, sessionId, resumeCwd\) \{[\s\S]*?\n\}/)?.[0];
    expect(source).toBeDefined();
    const resumeCmd = new Function(`${source}; return resumeCmd;`)() as (
      provider: string,
      sessionId: string,
      resumeCwd?: string,
    ) => string;

    expect(resumeCmd("codex-app-server", "019ff47d", "/tmp/repo"))
      .toBe("cd /tmp/repo && codex resume 019ff47d");
    expect(resumeCmd("claude", "claude-session"))
      .toBe("claude --resume claude-session");
    expect(resumeCmd("opencode-sdk", "ses_123"))
      .toBe("opencode --session ses_123");
  });
});
