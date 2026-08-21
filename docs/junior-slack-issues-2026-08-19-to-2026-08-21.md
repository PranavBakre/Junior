# Junior Slack mention audit — last 48 hours

Audit window: **2026-08-19 14:42 IST through 2026-08-21 14:42 IST** (inclusive).

Method: searched the read-only Slack archive for direct mentions of Junior (`<@U0ABKQ4V065>`), deduplicated 79 mentions into 40 Slack threads, and read the surrounding thread. Older thread roots are included when Junior was tagged inside them during the audit window. “No clear issue” means the visible thread shows Junior completing the requested action or stopping at an appropriate safety gate; it does not certify the underlying product change.

## Executive summary

The recurring problems were:

1. **Wrong execution boundary / unnecessary worktrees.** Read-only lookups, signed-URL generation, Junior-repo edits, and admin tasks were repeatedly routed into target-repo worktrees or agents that lacked the required files, credentials, network path, or write permissions.
2. **Delegation loops instead of task completion.** Junior kept redispatching blocked work to `db-executioner`, `frontend`, or pipeline agents even after the blocker made the execution path impossible. Users then had to say “you need to do it, not agents,” “this run didn’t need any worktree,” or cancel the process.
3. **Premature or unsupported conclusions.** Junior answered before tracing the exact path, confused payload and rendering failures, answered the wrong layer twice in the LinkedIn investigation, and initially audited bug status without reading the actual replies.
4. **Overclaiming progress.** Messages such as “started,” “creating,” or “running” appeared before access/preflight was established. Several tasks then ended with no write, no artifact, or a runtime blocker.
5. **Evidence mismatch.** A non-DRM harness was presented as proof for a DRM caption path; Storybook was used when the user had explicitly supplied production credentials; code-only inference was initially treated as bug-status evidence.
6. **Noisy state handling.** Duplicate bot messages, deleted placeholders, raw internal tool/status messages, repeated handoffs after cancellation, and active-writer/resume failures made threads confusing.

## Threads with clear Junior issues

| # | Thread | Request | What went wrong | Outcome / severity |
|---|---|---|---|---|
| 1 | [Download module videos](https://teamgrowthx.slack.com/archives/C0338BCK1UL/p1787295764543499) | Find module records and return signed MP4 links. | Junior created a worktree for a DB/read-and-sign task. Low disk then killed four consecutive pipeline assignments, including after the user twice said no worktree was needed and asked it to recover. Only one link was produced; the second item was not cleanly resolved. | **High — wrong routing, retry loop, ignored correction.** |
| 2 | [LinkedIn missing during event signup](https://teamgrowthx.slack.com/archives/C0338BCK1UL/p1787246680498799) | Explain how an account was created without a required LinkedIn URL. | Junior answered the wrong question twice, first claiming LinkedIn was optional enrichment, then focusing on registration-answer/profile sync. It spoke before tracing the actual account-creation path, triggered an active-writer pipeline error, and later built despite being assigned review while another bot was already building. | **High — incorrect diagnosis, scope confusion, duplicated work.** |
| 3 | [Fix/review event-registration changes](https://teamgrowthx.slack.com/archives/C0AKQ2BFN9F/p1787203747081219) | Fix the reported issue, raise PRs, then review. | The user had to ask for the PR multiple times and later explicitly say “you review it.” This shows the pipeline did not preserve the requested build → PR → review transition cleanly. | **Medium — handoff/state-machine failure and repeated prompting.** |
| 4 | [Experiment admin dashboard](https://teamgrowthx.slack.com/archives/C0338BCK1UL/p1787205605186319) | Inspect experiments and build the admin dashboard surface, then raise PRs. | The user had to return and ask “raise the PRs?” after the build flow. The thread indicates incomplete finalization/hand-off rather than a closed deliverable. | **Medium — completion reporting and PR finalization gap.** |
| 5 | [Pranav Tyagi / Convex event-chat error](https://teamgrowthx.slack.com/archives/C0338BCK1UL/p1787235145969339) | Identify the user, inspect New Relic, explain the error and prior activity in IST. | Junior needed repeated corrections: convert timings to IST, investigate the actual error, check earlier activity, and confirm whether event chat had moved to Convex. It did not structure the first pass around all requested questions. | **Medium — incomplete first-pass investigation.** |
| 6 | [Hermes Buildathon membership grant](https://teamgrowthx.slack.com/archives/C01JGSS97RD/p1787121852415419) | Grant memberships from CSV, list unmatched users, then add the successful procedure to a runbook. | Junior claimed the grant had started before file access and workspace prerequisites were known; repeatedly dispatched an agent without the CSV/worktree/fetch permissions; ignored the instruction to do it itself until explicitly corrected; then registered an unnecessary worktree for its own repo. The user had to intervene several times. | **High — premature claims, repeated bad dispatch, unnecessary worktree.** |
| 7 | [AI Roadmap v5 product-update post](https://teamgrowthx.slack.com/archives/C0338BCK1UL/p1787205478163669) | Use supplied credentials and Playwright to capture production screenshots and post a consistent update. | Junior went down a Storybook path despite explicit credentials and production instructions. It also confused the product label “V5” with roadmap version number 7, requiring correction. | **High — ignored explicit environment and misunderstood versioning.** |
| 8 | [Audit 200 bugs](https://teamgrowthx.slack.com/archives/C0338BCK1UL/p1787201726603519) | Read every bug and thread, classify resolution, owners, evidence, and follow-ups. | Junior first asked which list despite the attached Markdown; then produced a code-heavy audit before reading the actual thread replies. A fresh read later changed 31 statuses. DMs were sent from the stale first ledger and then had to be updated. | **High — evidence ordering error caused incorrect status/accountability outreach.** |
| 9 | [Image-only DM/feed/thread rendering](https://teamgrowthx.slack.com/archives/C05557KKV37/p1787236199943819) | Fix pasted images appearing blank on desktop across DMs, feed, and threads. | Junior initially asserted images were missing from the delivered payload, then the user established that mobile worked and desktop did not. The reproducer was dispatched without required intake artifacts; multiple handoffs continued after cancellation. A fix eventually landed, but only after avoidable misdiagnosis and noisy lifecycle behavior. | **High — premature root cause, broken intake, cancellation/handoff race.** |
| 10 | [Create short-extension member segment](https://teamgrowthx.slack.com/archives/C06H5ST104A/p1785432021307599) | Create a production segment for 3,764 users; after network denial, write a migration script. | Junior announced production execution before confirming network permission. After the user switched to a migration-script request, the dispatched worker had a read-only worktree and created nothing. | **High — prerequisite checks came after claiming execution.** |
| 11 | [Membership/event registration eligibility](https://teamgrowthx.slack.com/archives/C05557KKV37/p1787024977059059) | Re-check whether the affected user can now register. | The original diagnosis/fix was generally strong, but the later direct check was cancelled and restarted. Across the long thread Junior also could not consume an attached screenshot at first. | **Low — avoidable restart and attachment handling friction.** |
| 12 | [Dinner With Strangers admin audit](https://teamgrowthx.slack.com/archives/C05557KKV37/p1787291597703169) | Report all admin-side changes with IST timings and approval counts/timeline. | Follow-up questions (“how many people were approving and what the timeline”) show the first response did not fully answer the requested audit dimensions. | **Medium — incomplete audit synthesis.** |
| 13 | [Admin-route errors in New Relic](https://teamgrowthx.slack.com/archives/C05557KKV37/p1787291666622819) | List backend errors for `/admin/*`. | The task required a bounded observability query; the visible flow does not show a completed answer in-thread. | **Medium — no visible completion.** |
| 14 | [User/event issue and PR](https://teamgrowthx.slack.com/archives/C05557KKV37/p1787141763604789) | Diagnose a user issue, fix it, raise a PR, and start review. | Junior moved through implementation before the user’s later explicit request for PR/review, and the overall thread required follow-up to turn work into a publishable reviewed change. | **Medium — incomplete delivery loop.** |
| 15 | [Create private community channel from CSV](https://teamgrowthx.slack.com/archives/C0338BCK1UL/p1787240542587409) | Create a private GrowthX Community channel and add everyone in the CSV. | Junior first dispatched against Mongo even though community chat is in Convex, then retried without the CSV, production selectors, dependencies, or executor. It claimed the workflow was attached before verifying those inputs. No channel was created; the humans abandoned the plan for event chat. | **High — wrong datastore, missing prerequisites, no outcome.** |
| 16 | [Remove event interests/gallery images](https://teamgrowthx.slack.com/archives/C0338BCK1UL/p1787132208492719) | Remove two scoped fields while preserving the gallery document. | Junior dispatched without a writable migration workspace, then retried with a worktree whose mandatory fetch could not run. No script or mutation resulted. | **High — predictable execution-boundary failure.** |
| 17 | [Marketing members in Bangalore](https://teamgrowthx.slack.com/archives/C01JGSS97RD/p1787135225828609) | DM a filtered member list. | The only Junior response is a deleted placeholder; there is no visible result or explanation. | **High — silent/non-completion.** |
| 18 | [Subtitles for DRM videos](https://teamgrowthx.slack.com/archives/C0BHF7JFUBS/p1787115969668919) | Review the subtitle PR and merge if approved. | Junior correctly held the merge, but the preceding proof used a public non-DRM harness while presenting screenshots as if the feature was validated. After identifying real-DRM and preview-CORS gates, the change was merged to dev without visible evidence those gates were cleared; only code review/tests passed. | **High — verification claim did not match production condition.** |
| 19 | [Download links — explicit no-worktree retry](https://teamgrowthx.slack.com/archives/C0338BCK1UL/p1787296446189319) | Retry the same signed-link task with “DO NOT MAKE A WORKTREE.” | This new thread existed only because the prior run ignored the execution constraint. The duplication itself is evidence of failed recovery/context carryover. | **Medium — user had to restart task with stronger wording.** |
| 20 | [Web/mobile activity source field](https://teamgrowthx.slack.com/archives/C0338BCK1UL/p1787247154590319) | Add/report source for event registration and account creation. | This was intertwined with the LinkedIn thread where Junior built work assigned to another bot despite being told to review. Responsibility boundaries were not respected. | **Medium — role collision and duplicate implementation.** |
| 21 | [Find all Pranav tags in 48 hours](https://teamgrowthx.slack.com/archives/C0338BCK1UL/p1787292158003799) | Search Slack and provide a linked list. | The visible thread contains the request but no visible completed report. | **Medium — no visible completion.** |
| 22 | [Random recent account creators](https://teamgrowthx.slack.com/archives/C06H5ST104A/p1787216683246909) | Return names and phone numbers for 10 random accounts created in the past week. | The archive search surfaced the request, but no visible delivered list in the audited context. | **Medium — no visible completion.** |
| 23 | [Event cancellation blocks re-registration](https://teamgrowthx.slack.com/archives/C0338BCK1UL/p1787303001981629) | Diagnose and raise a fix PR without using the bug pipeline. | This landed near the end of the audit window; no completed diagnosis/PR is visible yet. It should be treated as open, with special attention to honoring “don’t use the bug pipeline.” | **Open — too recent to judge completion.** |

## Review threads with no clear Junior failure

These are included because the request was to check **all** tagged threads, not only the bad ones.

| Thread | Result | Caveat |
|---|---|---|
| [Onboarding / PR #987](https://teamgrowthx.slack.com/archives/C0AKQ2BFN9F/p1787145944335279) | Approved cleanly; the initial vague request was cancelled and replaced with a PR URL. | No clear Junior issue. |
| [Three scoped PRs: #5708/#3647/#985](https://teamgrowthx.slack.com/archives/C0AKQ2BFN9F/p1787138287939449) | Found a backend blocker, re-reviewed after the fix, and merged dev/main PRs as requested. | No clear Junior issue. |
| [PR #1006](https://teamgrowthx.slack.com/archives/C0AKQ2BFN9F/p1787289663698609) | Correctly approved code but blocked merge on pending mobile audit and failing Vercel. | No clear Junior issue. |
| [PR #1005](https://teamgrowthx.slack.com/archives/C0AKQ2BFN9F/p1787289657292469) | Found/followed up an ordering blocker; kept changes requested while mobile audit remained pending. | GitHub review posting hit auth 404; operational limitation, not a review-quality failure. |
| [PR #1003](https://teamgrowthx.slack.com/archives/C0AKQ2BFN9F/p1787276923940409) | Raised a legacy-Slack warning, then withdrew it when the owner supplied migration context. | Reasonable correction; no clear failure. |
| [PR #999](https://teamgrowthx.slack.com/archives/C0AKQ2BFN9F/p1787219176132449) | Approved with explicit limits on local verification. | Dependencies missing; Vercel author-access failure. |
| [PR #998](https://teamgrowthx.slack.com/archives/C0AKQ2BFN9F/p1787217070010509) | Approved and verified GitHub review. | Vercel author-access failure was correctly classified as unrelated. |
| [PR #992](https://teamgrowthx.slack.com/archives/C0AKQ2BFN9F/p1787201567431199) | Approved review but refused merge while GitHub was unstable/Vercel failed. | Appropriate safety gate. |
| [Backend PR #3650](https://teamgrowthx.slack.com/archives/C0AKQ2BFN9F/p1787150765926829) | Found a post-commit 502 blocker, re-reviewed after fix, and blocked main merge because dev-first had not happened. | Appropriate. |
| [PR #987 direct review](https://teamgrowthx.slack.com/archives/C0AKQ2BFN9F/p1787138896174969) | Approved and merged successfully. | Tests unavailable because `vitest` was missing, but this was disclosed. |
| [PR #1002](https://teamgrowthx.slack.com/archives/C0AKQ2BFN9F/p1787274625406339) | Approved with verification limitations stated. | Dependencies/Vercel access issue. |
| [PR #1001](https://teamgrowthx.slack.com/archives/C0AKQ2BFN9F/p1787243629908209) | Approved review but correctly blocked merge on failing checks. | Appropriate. |
| [Backend PR #3655](https://teamgrowthx.slack.com/archives/C0AKQ2BFN9F/p1787215796487869) | Found two privacy/correctness blockers and failing formatting. | No clear Junior issue. |
| [PR #991](https://teamgrowthx.slack.com/archives/C0AKQ2BFN9F/p1787159658799029) | Found path traversal/local-file-read risk, then approved after two clean passes. | No clear Junior issue. |
| [PR #990](https://teamgrowthx.slack.com/archives/C0AKQ2BFN9F/p1787150355646139) | Required regression coverage, verified the fix, and blocked merge until dev-first. | No clear Junior issue. |
| [PR #5719](https://teamgrowthx.slack.com/archives/C0AKQ2BFN9F/p1787258321491819) | Approved with 55 passing tests and later merged to dev via gxt-admin. | No clear Junior issue. |
| [Expo PR #464](https://teamgrowthx.slack.com/archives/C0AKQ2BFN9F/p1787130913884189) | Approved but correctly left merge gated on pending CI. | No clear Junior issue. |

## Threads where the available archive context is insufficient for a firm verdict

| Thread | Why it is inconclusive |
|---|---|
| [Review/onboarding follow-up](https://teamgrowthx.slack.com/archives/C0AKQ2BFN9F/p1787145944335279) | The initial command was cancelled almost immediately; the subsequent explicit PR review succeeded. |
| [Event registration approval history](https://teamgrowthx.slack.com/archives/C05557KKV37/p1787291597703169) | The follow-up shows missing dimensions in the first answer, but the complete earlier response was not fully present in the bounded archive output. |

## Recommended fixes for Junior

1. Add an intake gate before any dispatch: classify the task as read-only lookup, local Junior-repo edit, target-repo code change, production mutation, or external-service action; attach only the resources that category requires.
2. Do not say “started,” “creating,” or “running” until file access, repo/worktree, credentials, network permission, dependencies, and write path have passed preflight.
3. Preserve explicit negative constraints (`no worktree`, `don’t use the bug pipeline`, `review—don’t build`) as durable session policy, not prompt text that can be lost at handoff.
4. Require evidence order: read the source thread/data first, then inspect code, then contact owners. Never send accountability messages from code-only inference.
5. Require verification parity: production/DRM/desktop/mobile claims need evidence from that exact path; harness or Storybook proof must be labelled partial.
6. On the first repeated blocker, change strategy. Do not redispatch the same assignment with the same missing capability.
7. Suppress internal lifecycle noise from Slack: raw tool names, duplicate mirrored bot messages, deleted placeholders, and repeated handoff notifications should not appear as user-facing output.
8. After cancellation, invalidate queued handoffs and recovery continuations for that task so work cannot restart minutes later.

## Remediation status

- [x] Worktree creation now follows the active assignment envelope; repo refs
  alone no longer create worktrees for orchestrator/planner turns.
- [x] Core agent contract preserves explicit negative constraints across
  handoffs and requires execution preflight before progress claims.
- [x] Core agent contract requires thread/source evidence before code inference
  and exact environment/path parity for verification claims.
- [x] Repeated identical blockers must change strategy or escalate rather than
  redispatch unchanged.
- [x] Internal durable-control tools are suppressed from live Slack statuses.
- [x] Full durable cancellation landed on `main` in PR #187 before this audit
  remediation; `!cancel` terminalizes assignments and continuation work.
