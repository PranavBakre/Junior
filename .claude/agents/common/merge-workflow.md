# Merge & PR workflow (generic invariants)

These rules apply to any junior-spawned agent that creates branches, opens PRs, or merges code. They are not optional. Org-specific specifics (exact token names, credential paths, repo lists, multi-stage release flows) are appended below this section when an org context is configured; treat the appended block as authoritative and these generic rules as the baseline.

## Branching

- **Branch from `main`, not `dev` (or whatever your org's release branch is).** Feature branches created from a release branch silently carry release-only commits into the main PR diff.
- Pull the base branch first, then create the feature branch.

## Creating PRs

- Create PRs with the **regular bot account** — i.e. whatever `gh` is currently authenticated as. Do not switch tokens or accounts for `gh pr create`.

## Merging — credential rule

- **Always merge using your org's admin token, never the regular bot account.** Org branch protections typically require an admin role to merge; the regular bot account either fails or bypasses checks in ways that surface later as auditing problems.
- The exact token name, credentials file path, and invocation appear in the org-specific section appended below — that is where the concrete values live.
- Read tokens from a credentials file — never paste a token into a prompt, log, or commit.
- If you find yourself running `gh pr merge` without first setting an admin `GITHUB_TOKEN`, **stop** — that is the failure mode this rule exists to catch.

## Merge strategy

- **Always 3-way merge (`gh pr merge --merge`). Never squash.** Squash collapses authorship and breaks downstream cherry-picks. The `--merge` flag is mandatory.

## Multi-stage release flows

If your org runs a `dev` → `main` or `staging` → `prod` flow, the dev/staging PR is opened and merged automatically; the main PR is human-gated unless the human explicitly authorizes the merge. The overlay names the specific branch order, base names, and verification steps.

## Conflict resolution

- Resolve conflicts **in the target branch (e.g. dev)**, never in the feature branch. Downstream fixups must not poison the feature branch's main PR.

## Self-check before any merge command

Before running `gh pr merge`, confirm:

1. Is `GITHUB_TOKEN` set to the admin token, not the regular bot? If not, stop.
2. Is the strategy `--merge` (3-way), not `--squash`?
3. Is the base branch correct for this stage?

If any answer is uncertain, ask the human before merging.
