import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  statSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoConfig } from "../config.ts";
import { GitHubAuthResolver } from "../github/auth.ts";
import { WorktreeManager } from "./manager.ts";

// Real-fs integration test. We create a tiny git repo in a tmpdir and let
// WorktreeManager run actual git commands against it, plus fake setup scripts
// that exercise the delegation contract.

let repoRoot: string;
let setupMarker: string;

// Helper: run a shell command in a given cwd, throwing on non-zero.
async function runIn(cwd: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`${args.join(" ")} failed: ${err}`);
  }
}

beforeAll(async () => {
  repoRoot = mkdtempSync(join(tmpdir(), "junior-wt-test-"));

  // Init a bare-but-usable git repo with one commit on `main`.
  await runIn(repoRoot, ["git", "init", "-q", "-b", "main"]);
  await runIn(repoRoot, ["git", "config", "user.email", "test@example.com"]);
  await runIn(repoRoot, ["git", "config", "user.name", "test"]);
  writeFileSync(join(repoRoot, "README.md"), "hello\n");
  writeFileSync(join(repoRoot, ".gitignore"), ".env*\n.cache/\n");
  await runIn(repoRoot, ["git", "add", "."]);
  await runIn(repoRoot, ["git", "commit", "-q", "-m", "init"]);
  // Add a second commit on a different ref so we can test baseRef forwarding.
  await runIn(repoRoot, ["git", "checkout", "-q", "-b", "feature/seeded"]);
  writeFileSync(join(repoRoot, "FEATURE.md"), "feature only\n");
  await runIn(repoRoot, ["git", "add", "."]);
  await runIn(repoRoot, ["git", "commit", "-q", "-m", "feature only"]);
  await runIn(repoRoot, ["git", "checkout", "-q", "main"]);
  // Set up a fake `origin` remote pointing at ourselves so `git fetch origin` succeeds.
  await runIn(repoRoot, ["git", "remote", "add", "origin", repoRoot]);
  await runIn(repoRoot, ["git", "fetch", "-q", "origin"]);

  // Fake setup script. Flag-based contract:
  //   <branch_name> --path <abs> [--base <ref>]
  // Owns the full worktree-creation lifecycle: fetch + worktree add + marker
  // write. This mirrors the real contract — Junior never pre-creates the
  // worktree when delegating; it hands the script the branch, target path,
  // and (optionally) base ref, and the script does the rest.
  //
  // The marker file dumps every received arg on its own line so tests can
  // assert exact arg ordering, presence/absence of --base, etc.
  setupMarker = join(repoRoot, "setup-marker.txt");
  const setupScript = join(repoRoot, "fake-setup.sh");
  writeFileSync(
    setupScript,
    `#!/usr/bin/env bash
set -e
# Dump every received arg on its own line BEFORE any validation, so even
# malformed invocations leave a marker for tests to inspect.
: > "${setupMarker}"
for a in "$@"; do
  printf '%s\\n' "$a" >> "${setupMarker}"
done
# Parse flag-based args.
BRANCH=""
ABS_TARGET=""
BASE_REF=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --path) ABS_TARGET="$2"; shift 2 ;;
    --base) BASE_REF="$2"; shift 2 ;;
    -*) echo "fake-setup: unknown flag: $1" >&2; exit 1 ;;
    *)
      if [[ -z "$BRANCH" ]]; then BRANCH="$1"; shift
      else echo "fake-setup: unexpected positional: $1" >&2; exit 1
      fi ;;
  esac
done
if [[ -z "$BRANCH" || -z "$ABS_TARGET" ]]; then
  echo "fake-setup: branch and --path required" >&2
  exit 1
fi
if [[ "$ABS_TARGET" != /* ]]; then
  echo "fake-setup: --path must be absolute, got: $ABS_TARGET" >&2
  exit 1
fi
git fetch origin --prune
if [[ -n "$BASE_REF" ]]; then
  git worktree add "$ABS_TARGET" -b "$BRANCH" "$BASE_REF"
else
  git worktree add "$ABS_TARGET" -b "$BRANCH" origin/main
fi
`,
  );
  chmodSync(setupScript, 0o755);

  // Non-fetching setup script — used by the inverse autofetch guard test.
  // Creates the worktree but never runs `git fetch`. If Junior also doesn't
  // fetch (correct delegating behavior), a fresh commit on origin/main won't
  // appear in the resulting worktree. Parses the same flag-based contract.
  const nonFetchingScript = join(repoRoot, "non-fetching-setup.sh");
  writeFileSync(
    nonFetchingScript,
    `#!/usr/bin/env bash
set -e
BRANCH=""
ABS_TARGET=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --path) ABS_TARGET="$2"; shift 2 ;;
    --base) shift 2 ;;
    -*) echo "non-fetching: unknown flag: $1" >&2; exit 1 ;;
    *)
      if [[ -z "$BRANCH" ]]; then BRANCH="$1"; shift
      else echo "non-fetching: unexpected positional: $1" >&2; exit 1
      fi ;;
  esac
done
git worktree add "$ABS_TARGET" -b "$BRANCH" origin/main
`,
  );
  chmodSync(nonFetchingScript, 0o755);

  // Failing setup script.
  const failScript = join(repoRoot, "fail-setup.sh");
  writeFileSync(
    failScript,
    `#!/usr/bin/env bash\necho "permission denied" >&2\nexit 1\n`,
  );
  chmodSync(failScript, 0o755);

  // Mirrors a real setup script: progress (and the actual failure reason) on
  // stdout, incidental warnings on stderr, with the reason last.
  const stdoutFailScript = join(repoRoot, "stdout-fail-setup.sh");
  writeFileSync(
    stdoutFailScript,
    `#!/usr/bin/env bash
echo "direnv: loading .envrc" >&2
echo "Migrating MCPs..."
echo "Installing dependencies..."
echo "npm ERR! code ERESOLVE"
exit 1
`,
  );
  chmodSync(stdoutFailScript, 0o755);

  const chattyFailScript = join(repoRoot, "chatty-fail-setup.sh");
  writeFileSync(
    chattyFailScript,
    `#!/usr/bin/env bash
for i in $(seq 1 12000); do
  echo "stdout progress line $i: installing dependencies and migrating tooling"
  echo "stderr warning line $i: noisy package manager diagnostic" >&2
done
echo "FINAL SETUP FAILURE: dependency resolution failed" >&2
exit 1
`,
  );
  chmodSync(chattyFailScript, 0o755);

  const partialFailScript = join(repoRoot, "partial-fail-setup.sh");
  writeFileSync(
    partialFailScript,
    `#!/usr/bin/env bash
set -e
BRANCH="$1"
shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    --path) ABS_TARGET="$2"; shift 2 ;;
    --base) BASE_REF="$2"; shift 2 ;;
  esac
done
git worktree add "$ABS_TARGET" -b "$BRANCH" "$BASE_REF"
echo "no space left on device" >&2
exit 1
`,
  );
  chmodSync(partialFailScript, 0o755);

  // Exits immediately but leaves a child with inherited stdout/stderr open.
  // This proves the timeout terminates the full process group, not just a
  // wrapper whose `exited` promise has already resolved.
  const pipeHolderScript = join(repoRoot, "pipe-holder-setup.sh");
  writeFileSync(pipeHolderScript, [
    "#!/usr/bin/env bash",
    "( sleep 30 ) &",
    "exit 0",
    "",
  ].join("\n"));
  chmodSync(pipeHolderScript, 0o755);

  const environmentProbeScript = join(repoRoot, "environment-probe-setup.sh");
  writeFileSync(environmentProbeScript, [
    "#!/usr/bin/env bash",
    "set -e",
    `printf '%s\\n' " + "\"GIT_TERMINAL_PROMPT=$GIT_TERMINAL_PROMPT\" > \"${join(repoRoot, "environment-probe.txt")}\"`,
    `printf '%s\\n' " + "\"GIT_SSH_COMMAND=$GIT_SSH_COMMAND\" >> \"${join(repoRoot, "environment-probe.txt")}\"`,
    `printf '%s\\n' " + "\"GIT_CONFIG_KEY_0=$GIT_CONFIG_KEY_0\" >> \"${join(repoRoot, "environment-probe.txt")}\"`,
    `printf '%s\\n' " + "\"GIT_CONFIG_VALUE_0=$GIT_CONFIG_VALUE_0\" >> \"${join(repoRoot, "environment-probe.txt")}\"`,
    "BRANCH=\"$1\"",
    "shift",
    "while [[ $# -gt 0 ]]; do",
    "  case \"$1\" in",
    "    --path) TARGET=\"$2\"; shift 2 ;;",
    "    --base) BASE=\"$2\"; shift 2 ;;",
    "    *) shift ;;",
    "  esac",
    "done",
    "git worktree add \"$TARGET\" -b \"$BRANCH\" \"$BASE\"",
    "",
  ].join("\n"));
  chmodSync(environmentProbeScript, 0o755);
});

afterAll(() => {
  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(`${repoRoot}.junior-worktrees`, { recursive: true, force: true });
});

/**
 * Add a fresh commit on `main` (which is also the `origin` remote since
 * the test repo's origin self-references). The new file is only visible
 * via `origin/main` AFTER a fresh `git fetch origin`, so its presence in
 * a created worktree proves the creator fetched before `git worktree add`.
 *
 * Returns the filename written.
 */
async function addFreshCommitOnMain(label: string): Promise<string> {
  const filename = `freshness-${label}.md`;
  writeFileSync(join(repoRoot, filename), `${label}\n`);
  await runIn(repoRoot, ["git", "add", filename]);
  await runIn(repoRoot, ["git", "commit", "-q", "-m", `freshness ${label}`]);
  return filename;
}

describe("WorktreeManager.createWorktree", () => {
  it("creates worktree inline when worktreeSetupCommand is not set", async () => {
    const repos: RepoConfig[] = [
      { name: "default-flow", path: repoRoot, defaultBase: "origin/main" },
    ];
    const wm = new WorktreeManager(repos);

    // Drop a fresh commit on main right before creating the worktree.
    // The worktree should pick it up only if Junior fetched first.
    const freshFile = await addFreshCommitOnMain("default-flow");

    const wtPath = await wm.createWorktree("default-flow", "default-thread");
    expect(wtPath).toBe(`${repoRoot}.junior-worktrees/slack-default-thread`);
    expect(existsSync(wtPath)).toBe(true);
    expect(existsSync(join(wtPath, "README.md"))).toBe(true);
    // Inline-path autofetch regression guard: fetch ran, so origin/main is fresh.
    expect(existsSync(join(wtPath, freshFile))).toBe(true);

    await wm.removeWorktree("default-flow", "default-thread");
  });

  it("delegates to worktreeSetupCommand with [branch, --path, absTargetPath]", async () => {
    const repos: RepoConfig[] = [
      {
        name: "custom-flow",
        path: repoRoot,
        defaultBase: "origin/main",
        worktreeSetupCommand: "fake-setup.sh",
      },
    ];
    const wm = new WorktreeManager(repos);

    if (existsSync(setupMarker)) rmSync(setupMarker);

    const wtPath = await wm.createWorktree("custom-flow", "custom-thread");

    // Script created the worktree (manager did not pre-create).
    expect(existsSync(wtPath)).toBe(true);
    expect(existsSync(join(wtPath, "README.md"))).toBe(true);

    // Marker proves the script received exactly the expected args, in order.
    expect(existsSync(setupMarker)).toBe(true);
    const args = (await Bun.file(setupMarker).text())
      .split("\n")
      .filter((l) => l.length > 0);
    expect(args).toEqual([
      "slack/custom-thread",
      "--path",
      `${repoRoot}.junior-worktrees/slack-custom-thread`,
      "--base",
      "origin/main",
    ]);
    expect(wtPath).toBe(`${repoRoot}.junior-worktrees/slack-custom-thread`);

    await wm.removeWorktree("custom-flow", "custom-thread");
  });

  it("passes the selected GitHub account token to delegated setup", async () => {
    const authMarker = join(repoRoot, "github-auth-marker.txt");
    const askpassMarker = join(repoRoot, "github-askpass-marker.txt");
    const authSetup = join(repoRoot, "github-auth-setup.sh");
    writeFileSync(
      authSetup,
      `#!/usr/bin/env bash
set -e
printf '%s' "\${GH_TOKEN:-}" > "${authMarker}"
printf '%s\\n' "$($GIT_ASKPASS 'Username for https://github.com:')" > "${askpassMarker}"
printf '%s\\n' "$($GIT_ASKPASS 'Password for https://github.com:')" >> "${askpassMarker}"
BRANCH="$1"
shift
while [[ $# -gt 0 ]]; do
  case "$1" in
    --path) TARGET="$2"; shift 2 ;;
    --base) BASE="$2"; shift 2 ;;
    *) shift ;;
  esac
done
git fetch origin --prune
git worktree add "$TARGET" -b "$BRANCH" "$BASE"
`,
    );
    chmodSync(authSetup, 0o755);

    const repos: RepoConfig[] = [{
      name: "selected-auth-flow",
      path: repoRoot,
      defaultBase: "origin/main",
      githubRepo: "GrowthX-Club/gx-client-next",
      githubUser: "gxt-admin",
      worktreeSetupCommand: "github-auth-setup.sh",
    }];
    const auth = new GitHubAuthResolver(repos, async (args) =>
      args[0] === "auth"
        ? { status: 0, stdout: "selected-token", stderr: "" }
        : { status: 0, stdout: "gxt-admin", stderr: "" },
    );
    const wm = new WorktreeManager(repos, { githubAuth: auth });

    await wm.createWorktree(
      "selected-auth-flow",
      "selected-auth-thread",
    );

    expect(await Bun.file(authMarker).text()).toBe("selected-token");
    expect(await Bun.file(askpassMarker).text()).toBe("x-access-token\nselected-token\n");
    await wm.removeWorktree("selected-auth-flow", "selected-auth-thread");
    rmSync(authMarker, { force: true });
    rmSync(askpassMarker, { force: true });
    rmSync(authSetup, { force: true });
  });

  it("forwards baseRef as --base to the setup script when set explicitly", async () => {
    const repos: RepoConfig[] = [
      {
        name: "delegate-baseref",
        path: repoRoot,
        defaultBase: "origin/main",
        worktreeSetupCommand: "fake-setup.sh",
      },
    ];
    const wm = new WorktreeManager(repos);

    if (existsSync(setupMarker)) rmSync(setupMarker);

    const wtPath = await wm.createWorktree(
      "delegate-baseref",
      "delegate-baseref-thread",
      "feature/seeded",
    );

    const args = (await Bun.file(setupMarker).text())
      .split("\n")
      .filter((l) => l.length > 0);
    expect(args).toEqual([
      "slack/delegate-baseref-thread",
      "--path",
      wtPath,
      "--base",
      "feature/seeded",
    ]);

    // Sanity: the script honored --base, so FEATURE.md (only on
    // feature/seeded) is present.
    expect(existsSync(join(wtPath, "FEATURE.md"))).toBe(true);

    await wm.removeWorktree("delegate-baseref", "delegate-baseref-thread");
  });

  it("forwards repo.defaultBase as --base when baseRef is unset", async () => {
    const repos: RepoConfig[] = [
      {
        name: "delegate-no-baseref",
        path: repoRoot,
        defaultBase: "origin/main",
        worktreeSetupCommand: "fake-setup.sh",
      },
    ];
    const wm = new WorktreeManager(repos);

    if (existsSync(setupMarker)) rmSync(setupMarker);

    await wm.createWorktree("delegate-no-baseref", "no-baseref-thread");

    const markerText = await Bun.file(setupMarker).text();
    const args = markerText.split("\n").filter((l) => l.length > 0);
    expect(args).toContain("--base");
    expect(args).toContain("origin/main");
    expect(args.length).toBe(5);

    await wm.removeWorktree("delegate-no-baseref", "no-baseref-thread");
  });

  it("does NOT fetch when delegating (script owns fetch — inverse autofetch guard)", async () => {
    const repos: RepoConfig[] = [
      {
        name: "no-double-fetch-flow",
        path: repoRoot,
        defaultBase: "origin/main",
        worktreeSetupCommand: "non-fetching-setup.sh",
      },
    ];
    const wm = new WorktreeManager(repos);

    // Drop a fresh commit on main. The non-fetching setup script will NOT
    // fetch, and Junior must NOT fetch either when delegating. So the new
    // commit must be ABSENT from the resulting worktree. If the file shows
    // up, Junior fetched behind the script's back — a regression.
    const freshFile = await addFreshCommitOnMain("no-double-fetch");

    const wtPath = await wm.createWorktree(
      "no-double-fetch-flow",
      "no-double-thread",
    );

    expect(existsSync(wtPath)).toBe(true);
    expect(existsSync(join(wtPath, freshFile))).toBe(false);

    await wm.removeWorktree("no-double-fetch-flow", "no-double-thread");
  });

  it("throws when worktreeSetupCommand exits non-zero", async () => {
    const repos: RepoConfig[] = [
      {
        name: "fail-flow",
        path: repoRoot,
        defaultBase: "origin/main",
        worktreeSetupCommand: "fail-setup.sh",
      },
    ];
    const wm = new WorktreeManager(repos);

    await expect(
      wm.createWorktree("fail-flow", "fail-thread"),
    ).rejects.toThrow(/fail-setup\.sh failed/);

    // The failing script never created the worktree, so no cleanup needed.
    expect(existsSync(wm.getWorktreePath("fail-flow", "fail-thread"))).toBe(
      false,
    );
  });

  it("surfaces a stdout-only failure reason and points at the full transcript", async () => {
    const wm = new WorktreeManager([{
      name: "stdout-fail-flow",
      path: repoRoot,
      defaultBase: "origin/main",
      worktreeSetupCommand: "stdout-fail-setup.sh",
    }], { setupMinFreeBytes: 0 });

    let message = "";
    try {
      await wm.createWorktree("stdout-fail-flow", "stdout-fail-thread");
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    // The reason lives on stdout — the stream the old error path discarded.
    expect(message).toContain("npm ERR! code ERESOLVE");
    expect(message).toContain("exit 1");
    expect(message.length).toBeLessThan(500);
    const logPath = message.match(/full output: (\S+\.log)/)?.[1];
    expect(logPath).toBeDefined();
    expect(existsSync(logPath!)).toBe(true);
    const transcript = readFileSync(logPath!, "utf8");
    expect(transcript).toContain("npm ERR! code ERESOLVE");
    expect(transcript).toContain("direnv: loading .envrc");
    expect((statSync(logPath!).mode & 0o777)).toBe(0o600);
    rmSync(logPath!, { force: true });
  });

  it("drains chatty setup output without deadlocking and keeps the outward error bounded", async () => {
    const wm = new WorktreeManager([{
      name: "chatty-fail-flow",
      path: repoRoot,
      defaultBase: "origin/main",
      worktreeSetupCommand: "chatty-fail-setup.sh",
    }], { setupMinFreeBytes: 0 });

    let message = "";
    try {
      await wm.createWorktree("chatty-fail-flow", "chatty-fail-thread");
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toContain("FINAL SETUP FAILURE");
    expect(message.length).toBeLessThan(500);
    const logPath = message.match(/full output: (\S+\.log)/)?.[1];
    expect(logPath).toBeDefined();
    expect(readFileSync(logPath!, "utf8")).toContain("stdout progress line 12000");
    rmSync(logPath!, { force: true });
  });

  it("bounds a setup whose exited wrapper leaves a descendant holding pipes", async () => {
    const wm = new WorktreeManager([{
      name: "pipe-holder-flow",
      path: repoRoot,
      defaultBase: "origin/main",
      worktreeSetupCommand: "pipe-holder-setup.sh",
    }], {
      setupMinFreeBytes: 0,
      setupCommandTimeoutMs: 250,
      terminationGraceMs: 25,
    });

    const started = Date.now();
    await expect(wm.createWorktree("pipe-holder-flow", "pipe-holder-thread"))
      .rejects.toThrow(/timed out after 250ms/);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("sets fail-fast noninteractive Git transport for delegated setup", async () => {
    const probe = join(repoRoot, "environment-probe.txt");
    rmSync(probe, { force: true });
    const wm = new WorktreeManager([{
      name: "environment-probe-flow",
      path: repoRoot,
      defaultBase: "origin/main",
      worktreeSetupCommand: "environment-probe-setup.sh",
    }], { setupMinFreeBytes: 0 });

    await wm.createWorktree("environment-probe-flow", "environment-probe-thread");
    const environment = readFileSync(probe, "utf8");
    expect(environment).toContain("GIT_TERMINAL_PROMPT=0");
    expect(environment).toContain("-oBatchMode=yes");
    expect(environment).toContain("GIT_CONFIG_KEY_0=credential.helper");
    expect(environment).toContain("GIT_CONFIG_VALUE_0=");
    await wm.removeWorktree("environment-probe-flow", "environment-probe-thread");
    rmSync(probe, { force: true });
  });

  it("refuses dependency-heavy setup when disk headroom is too low", async () => {
    const wm = new WorktreeManager([{
      name: "low-disk-flow",
      path: repoRoot,
      defaultBase: "origin/main",
      worktreeSetupCommand: "fake-setup.sh",
    }], {
      setupMinFreeBytes: 2_000,
      availableBytes: async () => 1_000,
    });

    await expect(wm.createWorktree("low-disk-flow", "low-disk-thread"))
      .rejects.toThrow(/1000 MiB required|free disk space/);
    expect(existsSync(wm.getWorktreePath("low-disk-flow", "low-disk-thread"))).toBe(false);
  });

  it("rolls back a worktree when delegated setup fails after creation", async () => {
    const wm = new WorktreeManager([{
      name: "partial-fail-flow",
      path: repoRoot,
      defaultBase: "origin/main",
      worktreeSetupCommand: "partial-fail-setup.sh",
    }], { setupMinFreeBytes: 0 });

    await expect(wm.createWorktree("partial-fail-flow", "partial-fail-thread"))
      .rejects.toThrow(/no space left on device/);
    expect(existsSync(wm.getWorktreePath("partial-fail-flow", "partial-fail-thread"))).toBe(false);
    const branchProc = Bun.spawn(
      ["git", "branch", "--list", "slack/partial-fail-thread"],
      { cwd: repoRoot, stdout: "pipe" },
    );
    await branchProc.exited;
    expect((await new Response(branchProc.stdout).text()).trim()).toBe("");
  });

  it("forwards baseRef as the worktree's starting point (inline path)", async () => {
    const repos: RepoConfig[] = [
      { name: "baseref-flow", path: repoRoot, defaultBase: "origin/main" },
    ];
    const wm = new WorktreeManager(repos);

    const wtPath = await wm.createWorktree(
      "baseref-flow",
      "baseref-thread",
      "feature/seeded",
    );

    // Worktree should have started from the seeded feature branch, so
    // FEATURE.md (only on feature/seeded) is present.
    expect(existsSync(join(wtPath, "FEATURE.md"))).toBe(true);

    // But the new branch is still the default thread-keyed name.
    const branchProc = Bun.spawn(["git", "branch", "--show-current"], {
      cwd: wtPath,
      stdout: "pipe",
    });
    await branchProc.exited;
    const currentBranch = (await new Response(branchProc.stdout).text()).trim();
    expect(currentBranch).toBe("slack/baseref-thread");

    await wm.removeWorktree("baseref-flow", "baseref-thread");
  });

  it("uses branchOverride for the new branch name (inline path)", async () => {
    const repos: RepoConfig[] = [
      {
        name: "branch-override-flow",
        path: repoRoot,
        defaultBase: "origin/main",
      },
    ];
    const wm = new WorktreeManager(repos);

    const wtPath = await wm.createWorktree(
      "branch-override-flow",
      "override-thread",
      undefined, // baseRef defaults to repo.defaultBase (origin/main)
      "fix/custom-name", // branchOverride
    );

    const branchProc = Bun.spawn(["git", "branch", "--show-current"], {
      cwd: wtPath,
      stdout: "pipe",
    });
    await branchProc.exited;
    const currentBranch = (await new Response(branchProc.stdout).text()).trim();
    expect(currentBranch).toBe("fix/custom-name");

    // From origin/main: README.md present, FEATURE.md absent.
    expect(existsSync(join(wtPath, "README.md"))).toBe(true);
    expect(existsSync(join(wtPath, "FEATURE.md"))).toBe(false);

    // removeWorktree must read the actual branch name and clean it up,
    // not assume `slack/<threadId>`.
    await wm.removeWorktree("branch-override-flow", "override-thread");

    // Verify the override branch is gone.
    const listProc = Bun.spawn(
      ["git", "branch", "--list", "fix/custom-name"],
      { cwd: repoRoot, stdout: "pipe" },
    );
    await listProc.exited;
    const listed = (await new Response(listProc.stdout).text()).trim();
    expect(listed).toBe("");
  });

  it("surfaces a non-atomic ignored leftover after git removes the worktree registry entry", async () => {
    const wm = new WorktreeManager([{
      name: "non-atomic-remove",
      path: repoRoot,
      defaultBase: "origin/main",
    }]);
    const threadId = "non-atomic-remove-thread";
    const wtPath = await wm.createWorktree("non-atomic-remove", threadId);
    const originalRunGit = (wm as unknown as {
      runGit: (args: string[], cwd: string, env?: Record<string, string>) => Promise<string>;
    }).runGit.bind(wm);
    (wm as unknown as {
      runGit: (args: string[], cwd: string, env?: Record<string, string>) => Promise<string>;
    }).runGit = async (args, cwd, env) => {
      const output = await originalRunGit(args, cwd, env);
      if (args[0] === "worktree" && args[1] === "remove") {
        mkdirSync(wtPath);
        writeFileSync(join(wtPath, ".env.local"), "SECRET=must-not-be-logged\n");
      }
      return output;
    };

    await expect(wm.removeWorktree("non-atomic-remove", threadId))
      .rejects.toThrow(new RegExp(`worktree removal incomplete: filesystem path remains: ${wtPath}`));
    expect(existsSync(wtPath)).toBe(true);
    rmSync(wtPath, { recursive: true, force: true });
  });

  it("delegates branchOverride to the setup script", async () => {
    const repos: RepoConfig[] = [
      {
        name: "delegate-branch-override",
        path: repoRoot,
        defaultBase: "origin/main",
        worktreeSetupCommand: "fake-setup.sh",
      },
    ];
    const wm = new WorktreeManager(repos);

    if (existsSync(setupMarker)) rmSync(setupMarker);

    const wtPath = await wm.createWorktree(
      "delegate-branch-override",
      "delegate-override-thread",
      undefined,
      "fix/delegated-name",
    );

    const args = (await Bun.file(setupMarker).text())
      .split("\n")
      .filter((l) => l.length > 0);
    expect(args).toEqual(["fix/delegated-name", "--path", wtPath, "--base", "origin/main"]);

    await wm.removeWorktree("delegate-branch-override", "delegate-override-thread");
  });

  it("getWorktreePath strips trailing slashes from repo.path", () => {
    // Regression guard: a config with a trailing slash on `path` must NOT
    // produce a path INSIDE the repo (`<repo>/.junior-worktrees/...`) — that
    // would re-introduce the recursive-copy bug this directory move solves.
    const repos: RepoConfig[] = [
      {
        name: "trailing-slash",
        path: `${repoRoot}/`,
        defaultBase: "origin/main",
      },
    ];
    const wm = new WorktreeManager(repos);
    expect(wm.getWorktreePath("trailing-slash", "t1")).toBe(
      `${repoRoot}.junior-worktrees/slack-t1`,
    );
  });

  it("reports zero unpushed commits for a fresh worktree", async () => {
    const repos: RepoConfig[] = [
      { name: "clean-status", path: repoRoot, defaultBase: "origin/main" },
    ];
    const wm = new WorktreeManager(repos);

    const wtPath = await wm.createWorktree("clean-status", "clean-status-thread");
    const status = await wm.getWorktreeStatus(wtPath, "clean-status");

    expect(status.tracked).toEqual([]);
    expect(status.untracked).toEqual([]);
    expect(status.ignoredDotenv).toEqual([]);
    expect(status.unpushedCommits).toBe(0);
    expect(status.unpushedBase).toBe("origin/main");

    await wm.removeWorktree("clean-status", "clean-status-thread");
  });

  it("enumerates ignored dotenv paths without reading multiline secret contents", async () => {
    const repos: RepoConfig[] = [
      { name: "dotenv-status", path: repoRoot, defaultBase: "origin/main" },
    ];
    const wm = new WorktreeManager(repos);

    const wtPath = await wm.createWorktree("dotenv-status", "dotenv-status-thread");
    const secret = "API_KEY=one\nPRIVATE_KEY=two\n";
    writeFileSync(join(wtPath, ".env.local"), secret);

    const status = await wm.getWorktreeStatus(wtPath, "dotenv-status");

    expect(status.ignoredDotenv).toEqual([".env.local"]);
    expect(JSON.stringify(status)).not.toContain(secret);

    await wm.removeWorktree("dotenv-status", "dotenv-status-thread");
  });

  it("finds dotenv state even when unrelated ignored output exceeds the git stream cap", async () => {
    const repos: RepoConfig[] = [
      { name: "dotenv-noise-status", path: repoRoot, defaultBase: "origin/main" },
    ];
    const wm = new WorktreeManager(repos);
    const wtPath = await wm.createWorktree(
      "dotenv-noise-status",
      "dotenv-noise-status-thread",
    );
    const noiseDir = join(wtPath, ".cache");
    mkdirSync(noiseDir);
    for (let i = 0; i < 5_000; i += 1) {
      writeFileSync(join(noiseDir, `ignored-${i.toString().padStart(5, "0")}`), "x");
    }
    writeFileSync(join(wtPath, ".env.local"), "SECRET=preserve\n");

    const status = await wm.getWorktreeStatus(wtPath, "dotenv-noise-status");

    expect(status.ignoredDotenv).toEqual([".env.local"]);

    await wm.removeWorktree("dotenv-noise-status", "dotenv-noise-status-thread");
  });

  it("detects committed local-only work when no upstream branch is configured", async () => {
    const repos: RepoConfig[] = [
      { name: "unpushed-status", path: repoRoot, defaultBase: "origin/main" },
    ];
    const wm = new WorktreeManager(repos);

    const wtPath = await wm.createWorktree(
      "unpushed-status",
      "unpushed-status-thread",
    );
    writeFileSync(join(wtPath, "LOCAL.md"), "local only\n");
    await runIn(wtPath, ["git", "add", "LOCAL.md"]);
    await runIn(wtPath, ["git", "commit", "-q", "-m", "local only"]);

    const status = await wm.getWorktreeStatus(wtPath, "unpushed-status");

    expect(status.tracked).toEqual([]);
    expect(status.untracked).toEqual([]);
    expect(status.unpushedCommits).toBe(1);
    expect(status.unpushedBase).toBe("origin/main");

    await wm.removeWorktree("unpushed-status", "unpushed-status-thread");
  });
});
