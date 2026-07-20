import type { JavaScriptPackageManager } from "../worktree/package-manager.ts";

/** Non-mutating repository and PR inspection safe in any reviewer cwd. */
const REVIEW_SAFE_INSPECTION_COMMAND_PATTERNS = [
  "git status",
  "git status *",
  "git diff",
  "git diff *",
  "git show *",
  "git log *",
  "git rev-parse *",
  "git merge-base *",
  "git branch --show-current",
  "git blame *",
  "git ls-files *",
  "gh api --method GET *",
  "gh api -X GET *",
  "gh pr list *",
  "gh pr view *",
  "gh pr diff *",
  "gh pr checks *",
] as const;

/** Commands that change refs/files and therefore require an isolated worktree. */
const REVIEW_WORKTREE_INSPECTION_COMMAND_PATTERNS = [
  "git fetch *",
  "gh pr checkout *",
] as const;

const VERIFICATION_SCRIPTS = [
  "test",
  "typecheck",
  "lint",
  "build",
  "check",
] as const;

/**
 * Build the shell allowlist for the package manager detected from the active
 * worktree. No repository names or organization-specific mappings belong in
 * this policy layer.
 */
export function worktreeVerificationCommandPatterns(
  packageManager: JavaScriptPackageManager,
): string[] {
  const commands = worktreeInspectionCommandPatterns();

  for (const script of VERIFICATION_SCRIPTS) {
    if (script === "test") {
      commands.push(`${packageManager} test`, `${packageManager} test *`);
    }
    commands.push(
      `${packageManager} run ${script}`,
      `${packageManager} run ${script} *`,
    );
    if (script === "test") {
      commands.push(
        `${packageManager} run test:*`,
      );
    }
  }

  return commands;
}

/** Repository/PR inspection that remains useful without JS package metadata. */
export function worktreeInspectionCommandPatterns(): string[] {
  return [
    ...REVIEW_SAFE_INSPECTION_COMMAND_PATTERNS,
    ...REVIEW_WORKTREE_INSPECTION_COMMAND_PATTERNS,
  ];
}

/** Read-only inspection for reviews without a registered worktree. */
export function reviewInspectionCommandPatterns(): string[] {
  return [...REVIEW_SAFE_INSPECTION_COMMAND_PATTERNS];
}
