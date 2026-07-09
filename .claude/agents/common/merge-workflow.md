# Merge & PR workflow (generic invariants)

These rules apply to any junior-spawned agent that creates branches, opens PRs, or merges code. They are not optional. Org-specific specifics (exact token names, credential paths, repo lists, multi-stage release flows) are appended below this section when an org context is configured; treat the appended block as authoritative and these generic rules as the baseline.

## Branching

- **Branch from `main`, not `dev` (or whatever your org's release branch is).** Feature branches created from a release branch silently carry release-only commits into the main PR diff.
- Pull the base branch first, then create the feature branch.

## Creating PRs

- Create PRs with the **regular (non-admin) account**. If the org-specific section appended below names a PR-creation account and how to switch to it, that section wins; otherwise use whatever `gh` is currently authenticated as.

## Merging - credential rule

- **Always merge using your org's admin token, never the regular bot account.** Org branch protections typically require an admin role to merge; the regular bot account either fails or bypasses checks in ways that surface later as auditing problems.
- The exact token name, credentials file path, and invocation appear in the org-specific section appended below - that is where the concrete values live.
- Read tokens from a credentials file - never paste a token into a prompt, log, or commit.
- If you find yourself running `gh pr merge` without first setting an admin `GITHUB_TOKEN`, **stop** - that is the failure mode this rule exists to catch.

## Merge strategy

- **Always 3-way merge (`gh pr merge --merge`). Never squash.** Squash collapses authorship and breaks downstream cherry-picks. The `--merge` flag is mandatory.

## Release flow: main is the primary PR, dev is secondary

If your org runs a `dev` → `main` (or `staging` → `prod`) flow:

- **The primary PR targets `main` and is reviewed against `main`.** That review is the real review - don't treat it as a formality ahead of a "real" dev PR.
- **A secondary PR to `dev` is raised POST-review and merged first**, to verify the change lands cleanly before the main PR moves. It is not the review target; it is a verification step.
- **The main PR stays open and human-gated.** Merging the dev PR does not authorize merging the main PR. Only merge main on explicit human authorization for that exact PR.

The org-specific section appended below names the concrete branch order, base names, and verification steps for this flow.

## Conflict resolution

- Resolve conflicts **in the target branch (e.g. dev)**, never in the feature branch. Downstream fixups must not poison the feature branch's main PR.

## Hard guardrails

1. **Never force-push.** `--force-with-lease` is permitted only when the human explicitly asks for cleanup on that specific PR branch - never as a default unstick move.
2. **Check the base before every merge.** Run `gh pr view <n> --json baseRefName` and confirm it matches the stage you intend. A main-based PR merged as if it were a dev PR has shipped straight to prod before - this check exists to catch exactly that.
3. **Stand-down means stand-down.** Told to stop, stand down, or leave something for human review → no further write actions (commits, pushes, merges, new branches) in that thread until explicitly re-authorized. This overrides every other rule in this file.
4. **Stacked PRs merge bottom-up, one at a time.** Retarget the next PR's base immediately after each merge. Never `--delete-branch` mid-stack - a child PR may still need that branch as its base.
5. **Stage explicit paths only.** Never `git add -A` or `git add .`. Untracked local files are not yours to sweep into a commit.

## Self-check before any merge command

Before running `gh pr merge`, confirm:

1. Ran `gh pr view <n> --json baseRefName` and the base is correct for this stage?
2. Is `GITHUB_TOKEN` set to the admin token, not the regular bot?
3. Is the strategy `--merge` (3-way), not `--squash`?
4. Is this PR actually authorized to merge now - or is it the human-gated main PR?

If any answer is uncertain, ask the human before merging.
