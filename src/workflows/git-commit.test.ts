import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { hashWorkflowContent } from "./definition.ts";
import {
  DASHBOARD_GIT_EMAIL,
  DASHBOARD_GIT_NAME,
  commitWorkflowFile,
  writeDashboardWorkflow,
} from "./git-commit.ts";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("commitWorkflowFile", () => {
  it("scoped-adds only the target path and leaves a dirty sibling uncommitted", async () => {
    const repo = await initRepo();
    writeFileSync(join(repo, "sibling.md"), "clean\n");
    await git(repo, ["add", "--", "sibling.md"]);
    await git(repo, ["commit", "-m", "sibling"]);
    writeFileSync(join(repo, "sibling.md"), "dirty\n");
    mkdirSync(join(repo, "workflows"), { recursive: true });
    writeFileSync(join(repo, "workflows", "worklog.workflow.md"), validMarkdown());
    await git(repo, ["add", "--", "workflows/worklog.workflow.md"]);
    await git(repo, ["commit", "-m", "workflow"]);

    const next = validMarkdown("worklog", "updated body");
    const result = await commitWorkflowFile({
      repoRoot: repo,
      allowedRoots: [repo],
      relativePath: "workflows/worklog.workflow.md",
      markdown: next,
      message: "workflow(worklog): update from dashboard",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stagedOnly).toEqual(["workflows/worklog.workflow.md"]);
    expect(await fileText(repo, "workflows/worklog.workflow.md")).toBe(next);
    expect(await fileText(repo, "sibling.md")).toBe("dirty\n");
    const author = (await git(repo, ["log", "-1", "--format=%an <%ae>"])).trim();
    expect(author).toBe(`${DASHBOARD_GIT_NAME} <${DASHBOARD_GIT_EMAIL}>`);
    const siblingStatus = (await git(repo, ["status", "--porcelain", "--", "sibling.md"]))
      .trim();
    expect(siblingStatus.startsWith(" M") || siblingStatus.startsWith("M ")).toBe(true);
  });

  it("rejects a path that escapes the repo", async () => {
    const repo = await initRepo();
    const result = await commitWorkflowFile({
      repoRoot: repo,
      allowedRoots: [repo],
      relativePath: "../secret.workflow.md",
      markdown: validMarkdown(),
      message: "nope",
    });
    expect(result).toMatchObject({ ok: false, code: "path-outside-repo" });
  });

  it("refuses unresolved conflicts", async () => {
    const repo = await initRepo();
    writeFileSync(join(repo, "conflict.txt"), "base\n");
    await git(repo, ["add", "--", "conflict.txt"]);
    await git(repo, ["commit", "-m", "base"]);
    await git(repo, ["checkout", "-b", "topic"]);
    writeFileSync(join(repo, "conflict.txt"), "topic\n");
    await git(repo, ["add", "--", "conflict.txt"]);
    await git(repo, ["commit", "-m", "topic"]);
    await git(repo, ["checkout", "main"]);
    writeFileSync(join(repo, "conflict.txt"), "main\n");
    await git(repo, ["add", "--", "conflict.txt"]);
    await git(repo, ["commit", "-m", "main"]);
    await git(repo, ["merge", "topic"], { allowFail: true });

    const result = await commitWorkflowFile({
      repoRoot: repo,
      allowedRoots: [repo],
      relativePath: "workflows/worklog.workflow.md",
      markdown: validMarkdown(),
      message: "nope",
    });
    expect(result).toMatchObject({ ok: false, code: "unresolved-conflicts" });
    expect(existsSync(join(repo, "workflows", "worklog.workflow.md"))).toBe(false);
  });

  it("refuses detached HEAD", async () => {
    const repo = await initRepo();
    await git(repo, ["checkout", "--detach"]);
    const result = await commitWorkflowFile({
      repoRoot: repo,
      allowedRoots: [repo],
      relativePath: "workflows/worklog.workflow.md",
      markdown: validMarkdown(),
      message: "nope",
    });
    expect(result).toMatchObject({ ok: false, code: "detached-head" });
    expect(existsSync(join(repo, "workflows", "worklog.workflow.md"))).toBe(false);
  });

  it("refuses merge and rebase in progress", async () => {
    const mergeRepo = await initRepo();
    writeFileSync(join(mergeRepo, "extra.txt"), "a\n");
    await git(mergeRepo, ["add", "--", "extra.txt"]);
    await git(mergeRepo, ["commit", "-m", "extra"]);
    await git(mergeRepo, ["checkout", "-b", "topic"]);
    writeFileSync(join(mergeRepo, "topic.txt"), "t\n");
    await git(mergeRepo, ["add", "--", "topic.txt"]);
    await git(mergeRepo, ["commit", "-m", "topic"]);
    await git(mergeRepo, ["checkout", "main"]);
    await git(mergeRepo, ["merge", "--no-commit", "--no-ff", "topic"]);
    const merging = await commitWorkflowFile({
      repoRoot: mergeRepo,
      allowedRoots: [mergeRepo],
      relativePath: "workflows/worklog.workflow.md",
      markdown: validMarkdown(),
      message: "nope",
    });
    expect(merging).toMatchObject({ ok: false, code: "merging" });

    const rebaseRepo = await initRepo();
    mkdirSync(join(rebaseRepo, ".git", "rebase-merge"));
    const rebasing = await commitWorkflowFile({
      repoRoot: rebaseRepo,
      allowedRoots: [rebaseRepo],
      relativePath: "workflows/worklog.workflow.md",
      markdown: validMarkdown(),
      message: "nope",
    });
    expect(rebasing).toMatchObject({ ok: false, code: "rebasing" });
  });

  it("restores the file to HEAD when a commit hook fails", async () => {
    const repo = await initRepo();
    mkdirSync(join(repo, "workflows"), { recursive: true });
    const original = validMarkdown();
    writeFileSync(join(repo, "workflows", "worklog.workflow.md"), original);
    await git(repo, ["add", "--", "workflows/worklog.workflow.md"]);
    await git(repo, ["commit", "-m", "workflow"]);

    writeFileSync(join(repo, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(repo, ".git", "hooks", "pre-commit"), 0o755);

    const result = await commitWorkflowFile({
      repoRoot: repo,
      allowedRoots: [repo],
      relativePath: "workflows/worklog.workflow.md",
      markdown: validMarkdown("worklog", "should not stick"),
      message: "nope",
    });
    expect(result).toMatchObject({ ok: false, code: "git-failed" });
    expect(await fileText(repo, "workflows/worklog.workflow.md")).toBe(original);
  });

  it("re-reads expectedVersionHash immediately before write", async () => {
    const repo = await initRepo();
    mkdirSync(join(repo, "workflows"), { recursive: true });
    const original = validMarkdown();
    writeFileSync(join(repo, "workflows", "worklog.workflow.md"), original);
    await git(repo, ["add", "--", "workflows/worklog.workflow.md"]);
    await git(repo, ["commit", "-m", "workflow"]);
    const concurrent = validMarkdown("worklog", "someone else wrote this");
    writeFileSync(join(repo, "workflows", "worklog.workflow.md"), concurrent);
    const result = await commitWorkflowFile({
      repoRoot: repo,
      allowedRoots: [repo],
      relativePath: "workflows/worklog.workflow.md",
      markdown: validMarkdown("worklog", "clobber"),
      message: "nope",
      expectedVersionHash: hashWorkflowContent(original),
    });
    expect(result).toMatchObject({ ok: false, code: "version-hash-mismatch" });
    expect(await fileText(repo, "workflows/worklog.workflow.md")).toBe(concurrent);
  });

  it("returns invalid-workflow instead of git-failed for schema errors", async () => {
    const repo = await initRepo();
    const result = await commitWorkflowFile({
      repoRoot: repo,
      allowedRoots: [repo],
      relativePath: "workflows/worklog.workflow.md",
      markdown: "---\nname: worklog\nenabled: true\nownerSlackUserIds: []\n---\nno schema",
      message: "nope",
    });
    expect(result).toMatchObject({ ok: false, code: "invalid-workflow" });
    expect(existsSync(join(repo, "workflows", "worklog.workflow.md"))).toBe(false);
  });
});

describe("writeDashboardWorkflow overlay parent pointer", () => {
  it("refuses overlay writes when agents-org is detached", async () => {
    const { junior, overlay, overlayFile, original } = await initOverlayPair();
    await git(overlay, ["checkout", "--detach"]);
    const result = await writeDashboardWorkflow({
      projectRoot: junior,
      sourceRoot: "overlay",
      name: "worklog",
      markdown: validMarkdown("worklog", "overlay update"),
      message: "workflow(worklog): update from dashboard",
      repos: [],
    });
    expect(result).toMatchObject({ ok: false, code: "detached-head" });
    expect(await Bun.file(overlayFile).text()).toBe(original);
  }, 15_000);

  it("does not write the overlay when parent preflight fails", async () => {
    const { junior, overlayFile, original } = await initOverlayPair();
    await git(junior, ["checkout", "--detach"]);
    const result = await writeDashboardWorkflow({
      projectRoot: junior,
      sourceRoot: "overlay",
      name: "worklog",
      markdown: validMarkdown("worklog", "overlay update"),
      message: "workflow(worklog): update from dashboard",
      repos: [],
    });
    expect(result).toMatchObject({ ok: false, code: "detached-head" });
    expect(await Bun.file(overlayFile).text()).toBe(original);
  }, 15_000);

  it("parent-adds only agents-org and leaves a dirty junior sibling unstaged", async () => {
    const { junior, overlay } = await initOverlayPair();
    writeFileSync(join(junior, "sibling.md"), "dirty junior\n");
    const markdown = validMarkdown("worklog", "overlay update");
    const result = await writeDashboardWorkflow({
      projectRoot: junior,
      sourceRoot: "overlay",
      name: "worklog",
      markdown,
      message: "workflow(worklog): update from dashboard",
      repos: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.overlayCommitted).toBe(true);
    expect(result.parentPointerCommitted).toBe(true);
    expect(result.commit.repo).toBe("agents-org");
    expect(result.versionHash).toBe(hashWorkflowContent(markdown));
    const parentFiles = result.parentPointer && "sha" in result.parentPointer
      ? (await git(junior, [
        "diff-tree",
        "--no-commit-id",
        "--name-only",
        "-r",
        result.parentPointer.sha,
      ])).trim()
      : "";
    expect(parentFiles).toBe("agents-org");
    expect(await fileText(junior, "sibling.md")).toBe("dirty junior\n");
    const siblingStatus = (await git(junior, ["status", "--porcelain", "--", "sibling.md"]))
      .trim();
    expect(siblingStatus.startsWith("??")).toBe(true);
    const overlayFiles = (await git(overlay, [
      "diff-tree",
      "--no-commit-id",
      "--name-only",
      "-r",
      result.commit.sha,
    ])).trim();
    expect(overlayFiles).toBe("workflows/worklog.workflow.md");
  }, 15_000);

  it("leaves the overlay commit when the parent hook fails", async () => {
    const { junior, overlay, overlayFile } = await initOverlayPair();
    writeFileSync(join(junior, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(junior, ".git", "hooks", "pre-commit"), 0o755);
    const beforeOverlay = (await git(overlay, ["rev-parse", "HEAD"])).trim();
    const markdown = validMarkdown("worklog", "overlay stays");
    const result = await writeDashboardWorkflow({
      projectRoot: junior,
      sourceRoot: "overlay",
      name: "worklog",
      markdown,
      message: "workflow(worklog): update from dashboard",
      repos: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.overlayCommitted).toBe(true);
    expect(result.parentPointerCommitted).toBe(false);
    expect(result.parentPointer).toMatchObject({ code: "git-failed" });
    expect(result.commit.sha).not.toBe(beforeOverlay);
    expect(await Bun.file(overlayFile).text()).toBe(markdown);
    expect((await git(overlay, ["rev-parse", "HEAD"])).trim()).toBe(result.commit.sha);
  }, 15_000);
});

function validMarkdown(name = "worklog", body = "Do the thing."): string {
  return [
    "---",
    `name: ${name}`,
    "enabled: true",
    "ownerSlackUserIds: []",
    "triggers:",
    "  - type: command",
    `    command: ${name}`,
    "outputs:",
    "  - type: docs",
    `    path: data/workflow-runs/${name}`,
    "permissions:",
    "  tools:",
    "    - docs.write",
    "---",
    body,
  ].join("\n");
}

async function initRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "junior-wf-git-"));
  dirs.push(dir);
  await git(dir, ["init", "-b", "main"]);
  await git(dir, ["config", "user.name", "t"]);
  await git(dir, ["config", "user.email", "t@t.test"]);
  await git(dir, ["config", "commit.gpgsign", "false"]);
  await git(dir, ["config", "core.hooksPath", ".git/hooks"]);
  writeFileSync(join(dir, "README.md"), "repo\n");
  await git(dir, ["add", "--", "README.md"]);
  await git(dir, ["commit", "-m", "init"]);
  return dir;
}

async function initOverlayPair(): Promise<{
  junior: string;
  overlay: string;
  overlayFile: string;
  original: string;
}> {
  const junior = await initRepo();
  const overlay = join(junior, "agents-org");
  mkdirSync(overlay, { recursive: true });
  await git(overlay, ["init", "-b", "main"]);
  await git(overlay, ["config", "user.name", "t"]);
  await git(overlay, ["config", "user.email", "t@t.test"]);
  await git(overlay, ["config", "commit.gpgsign", "false"]);
  mkdirSync(join(overlay, "workflows"), { recursive: true });
  const original = validMarkdown();
  writeFileSync(join(overlay, "workflows", "worklog.workflow.md"), original);
  await git(overlay, ["add", "--", "workflows/worklog.workflow.md"]);
  await git(overlay, ["commit", "-m", "overlay"]);
  writeFileSync(
    join(junior, ".gitmodules"),
    '[submodule "agents-org"]\n\tpath = agents-org\n\turl = ./agents-org\n',
  );
  await git(junior, ["add", "--", ".gitmodules", "agents-org"]);
  await git(junior, ["commit", "-m", "add overlay"]);
  await git(overlay, ["checkout", "-B", "main"]);
  return {
    junior,
    overlay,
    overlayFile: join(overlay, "workflows", "worklog.workflow.md"),
    original,
  };
}

async function fileText(repo: string, rel: string): Promise<string> {
  return Bun.file(join(repo, rel)).text();
}

async function git(
  cwd: string,
  args: string[],
  options: { allowFail?: boolean } = {},
): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0 && !options.allowFail) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr || stdout}`);
  }
  return stdout;
}
