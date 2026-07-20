/**
 * Shell commands a read-only reviewer may execute inside a Junior-managed
 * worktree. These are verification commands only: no dependency installation,
 * publishing, product-code edits, commits, or pushes.
 *
 * Repositories currently use npm by default, pnpm for gx-client-expo, and Bun
 * for Junior itself. Keep the patterns provider-neutral; Claude wraps them in
 * `Bash(...)` while OpenCode uses them as granular bash permission rules.
 */
export const WORKTREE_VERIFICATION_COMMAND_PATTERNS = [
  // Read-only repository and PR inspection.
  "git status",
  "git status *",
  "git diff",
  "git diff *",
  "git show *",
  "git log *",
  "git rev-parse *",
  "git merge-base *",
  "git branch --show-current",
  "git ls-files *",
  "git fetch *",
  "gh pr view *",
  "gh pr diff *",
  "gh pr checks *",
  "gh pr checkout *",

  // npm repositories.
  "npm test",
  "npm test *",
  "npm run test",
  "npm run test *",
  "npm run test:*",
  "npm run test:* *",
  "npm run typecheck",
  "npm run typecheck *",
  "npm run lint",
  "npm run lint *",
  "npm run build",
  "npm run build *",
  "npm run check",
  "npm run check *",
  // gx-client-expo.
  "pnpm test",
  "pnpm test *",
  "pnpm run test",
  "pnpm run test *",
  "pnpm run test:*",
  "pnpm run test:* *",
  "pnpm run typecheck",
  "pnpm run typecheck *",
  "pnpm run lint",
  "pnpm run lint *",
  "pnpm run build",
  "pnpm run build *",
  "pnpm run check",
  "pnpm run check *",
  // Junior.
  "bun test",
  "bun test *",
  "bun run test",
  "bun run test *",
  "bun run test:*",
  "bun run test:* *",
  "bun run typecheck",
  "bun run typecheck *",
  "bun run lint",
  "bun run lint *",
  "bun run build",
  "bun run build *",
  "bun run check",
  "bun run check *",
] as const;
