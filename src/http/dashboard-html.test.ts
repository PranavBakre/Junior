import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";

const publicDir = resolve(import.meta.dirname, "../../public");

describe("dashboard resume commands", () => {
  it("uses the CLI that owns each provider session", async () => {
    const html = await Bun.file(resolve(publicDir, "js/threads.js")).text();
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

describe("dashboard operator views", () => {
  it("includes Runbooks and Spend in the nav without merging Workflows", async () => {
    const html = await Bun.file(resolve(publicDir, "index.html")).text();
    const nav = html.match(/<nav id="nav"[\s\S]*?<\/nav>/)?.[0];
    expect(nav).toBeDefined();
    expect(nav).toContain('data-view="runbooks"');
    expect(nav).toContain("Runbooks");
    expect(nav).toContain('data-view="spend"');
    expect(nav).toContain("Spend");
    expect(nav).toContain('data-view="audit"');
    expect(nav).toContain("Audit");
    expect(nav).toContain('data-view="workflows"');
    expect(nav).toContain("Workflows");
    expect(nav!.indexOf('data-view="workflows"')).toBeLessThan(nav!.indexOf('data-view="runbooks"'));
  });

  it("keeps the galaxy canvas in the Memory view", async () => {
    const html = await Bun.file(resolve(publicDir, "index.html")).text();
    const memory = html.match(/id="view-memory"[\s\S]*?<\/section>/)?.[0];
    expect(memory).toBeDefined();
    expect(memory).toContain('id="memory-canvas"');

    const spend = html.match(/id="view-spend"[\s\S]*?<\/section>/)?.[0];
    expect(spend).toBeDefined();
    expect(spend).not.toContain("<canvas");
  });

  it("uses the specified empty copy for the runbook viewer", async () => {
    const source = await Bun.file(resolve(publicDir, "js/runbooks.js")).text();
    expect(source).toContain(
      "No runbooks loaded. Private overlay `agents-org/runbooks/` is empty or not mounted.",
    );
  });

  it("scrolls the desktop nav so Audit stays reachable", async () => {
    const html = await Bun.file(resolve(publicDir, "index.html")).text();
    expect(html).toMatch(/nav\s*\{[^}]*overflow-y:\s*auto/s);
  });

  it("prefers the overlay runbook path for copy", async () => {
    const source = await Bun.file(resolve(publicDir, "js/runbooks.js")).text();
    expect(source).toContain('agents-org/runbooks/" + rb.name + ".runbook.md');
  });

  it("guards spend and audit loads with a request generation", async () => {
    const spend = await Bun.file(resolve(publicDir, "js/spend.js")).text();
    const audit = await Bun.file(resolve(publicDir, "js/audit.js")).text();
    expect(spend).toContain("spendFetchGeneration");
    expect(audit).toContain("auditFetchGeneration");
  });

  it("keeps an out-of-filter pipeline selection and shows drawer spend", async () => {
    const pipelines = await Bun.file(resolve(publicDir, "js/pipelines.js")).text();
    const threads = await Bun.file(resolve(publicDir, "js/threads.js")).text();
    expect(pipelines).toContain("run not in current filter");
    expect(pipelines).toContain("function pipelineSummaryFor");
    expect(threads).toContain("formatSpendSummary(t.spend)");
  });

  it("loads spend, runbooks, and audit scripts after the existing modules", async () => {
    const html = await Bun.file(resolve(publicDir, "index.html")).text();
    const api = html.indexOf('"/js/api.js"');
    const spend = html.indexOf('"/js/spend.js"');
    const runbooks = html.indexOf('"/js/runbooks.js"');
    const audit = html.indexOf('"/js/audit.js"');
    const app = html.indexOf('"/js/app.js"');
    expect(api).toBeGreaterThan(-1);
    expect(spend).toBeGreaterThan(api);
    expect(runbooks).toBeGreaterThan(spend);
    expect(audit).toBeGreaterThan(runbooks);
    expect(app).toBeGreaterThan(audit);
  });
});
