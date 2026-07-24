# Durable run contract

Every ordinary task is backed by a `kind: default` run and an exact
`<pipeline-assignment>`. Product and bug pipelines use the same assignment
substrate with additional controller phases.

When an assignment block is present, finish the invocation with exactly one
accepted durable decision. Slack prose, Task/Agent, public `!agent` directives,
and GitHub comments do not settle an assignment.

- `pipeline_report_outcome` with `continue_self` queues another turn for the
  same assignment. Use it only when you have a concrete next step you can take.
- `agent_dispatch(mode="handoff")` completes your assignment and transfers
  ownership to exactly one successor.
- `agent_dispatch(mode="delegate")` creates a child assignment. Your assignment
  waits and is resumed automatically after the child reports `complete`.
- A worktree-backed target requires durable repository binding. Pass
  `repo_refs` to `agent_dispatch`; naming a repo only in the prompt or
  `artifact_refs` does not bind it. A missing repo is rejected before a child
  assignment is created.
- `wait` is only for a runtime-supported external event with a real durable
  wake source and a Unix-epoch-millisecond deadline. Never wait for another
  agent; delegate or hand off instead.
- `escalate` must name the blocker and the exact human decision or authority
  required.
- `complete` means this assignment's objective and acceptance criteria are
  satisfied. For a default run it completes the task; typed controllers may
  advance or fan in according to their own policy.

Use one transport per delegation. Do not call `agent_dispatch` and then also
report a handoff. An accepted or duplicate dispatch receipt is already the
durable outcome for this invocation.

Ids and `expectedRunVersion` come from the current `<pipeline-assignment>`.
Every `pipeline_report_outcome` payload includes the four array fields even
when empty. Canonical shapes:

```text
complete:      {assignmentId, expectedRunVersion, action:"complete", status:"succeeded", reason, evidenceRefs:[], artifactRefs:[], blockers:[], checks:[], progressFingerprint}
continue_self: {assignmentId, expectedRunVersion, action:"continue_self", status:"progress", reason, evidenceRefs:[], artifactRefs:[], blockers:[], checks:[], progressFingerprint}
wait:          {assignmentId, expectedRunVersion, action:"wait", status:"blocked", reason, evidenceRefs:[], artifactRefs:[], blockers:[], checks:[], progressFingerprint, wait:{conditionName, deadlineAt}}
escalate:      {assignmentId, expectedRunVersion, action:"escalate", status:"blocked", reason, evidenceRefs:[], artifactRefs:[], blockers:[{kind:"human_gate", detail}], checks:[], progressFingerprint}
```

Pass a stable `idempotency_key` beside the outcome. Never put `handoff` or
`delegate` in `pipeline_report_outcome`; those belong to `agent_dispatch`.

Use a stable semantic `idempotency_key` and reuse it on transport retries. On a
state-version conflict, call `pipeline_get_state`, verify the assignment is
still active, then retry once with the same semantic key. Never announce that
work advanced before the control-plane receipt is accepted. If the tool is
missing or disabled, report a control-plane failure instead of pretending that
Slack prose advanced the run.

After an infrastructure failure moves a run to `needs-human`, the next human
message creates a recovery assignment. Retry `agent_dispatch` from that
assignment with the corrected `repo_refs`; for typed product/bug runs also pass
the legal active `to_phase`. The repository update, phase resume, and successor
assignment commit atomically, so `!reset` is not required for this repair.

Starting a product or bug pipeline remains a separate intelligent decision.
Only an authorized orchestrator calls `pipeline_start_run`; it promotes the
current default run in place, preserves its history, and queues the typed child
assignments. After an accepted start receipt, do not dispatch the initial agent
again.
