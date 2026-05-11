# Merge & PR workflow (junior invariants)

These rules apply to any junior-spawned agent that creates branches, opens PRs, or merges. They are not optional.

## Branching

- **Branch from `main`, not `dev`.** Feature branches created from dev silently carry dev-only commits into the main PR diff. Pull `main`, then create the branch.

## Creating PRs

- Create PRs with the **regular bot account** — i.e. whatever `gh` is currently authenticated as. Do not switch tokens for `gh pr create`.

## Merging — credential rule

- **Always merge using the `gxt-admin` token, never the regular bot account.** Org branch protections require an admin to merge; the regular bot account fails or bypasses checks in ways that surface later as auditing problems.
- Token location: `~/Projects/junior/support/admin-credentials.yaml` under `github.gxt_admin_token`. Read it from the file — do not paste the token into a prompt or commit it anywhere.
- Invocation:
  ```bash
  GITHUB_TOKEN="$(yq '.github.gxt_admin_token' ~/Projects/junior/support/admin-credentials.yaml)" \
    gh pr merge <pr> --merge
  ```
  (Or read the file with whatever yaml parser is available — the point is `GITHUB_TOKEN` must be set to the gxt-admin token for the duration of the merge command.)
- If you find yourself running `gh pr merge` without `GITHUB_TOKEN=` prepended, **stop** — that is the failure mode this rule exists to catch.

## Merge strategy

- **Always 3-way merge (`gh pr merge --merge`). Never squash.** Squash collapses authorship and breaks downstream cherry-picks. The `--merge` flag is mandatory.

## GrowthX two-stage merge (`gx-backend`, `gx-client-next`, `gx-admin-client`)

For changes targeting any GX repo:

1. Open the feature → `main` PR (this is the canonical record).
2. Open a parallel feature → `dev` PR from the same branch (`gh pr create --base dev --head <branch>`).
3. Merge the **dev PR first** with the gxt-admin token. Verify on dev.
4. The `main` PR is **human-gated** — leave it open. Do not merge it yourself unless the human explicitly says so.

## Conflict resolution

- Resolve conflicts **in the target branch (e.g. dev)**, never in the feature branch. Dev-side fixups must not poison the feature branch's main PR.

## Self-check before any merge command

Before running `gh pr merge`, confirm out loud (or in your reasoning):

1. Is `GITHUB_TOKEN` set to the gxt-admin token? If not, stop.
2. Is the strategy `--merge` (3-way), not `--squash`?
3. Is the base branch the right one (dev for the dev PR, not main for GX repos unless human-gated)?

If any answer is uncertain, ask the human before merging.
