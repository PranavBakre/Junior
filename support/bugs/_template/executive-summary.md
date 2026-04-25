# executive summary — <bug-id>

one-page view of this bug. junior (the support lead) updates this after every sub-agent run. read-first artifact when a human checks in.

| field | value |
|-------|-------|
| **bug id** | <bug-id> |
| **product** | <events / learn / admin-* / community / ...> |
| **reporter** | <name + email> |
| **severity** | P0 / P1 / P2 / P3 |
| **status** | <state.json `status`> |
| **opened** | <YYYY-MM-DD HH:MM> |
| **last update** | <YYYY-MM-DD HH:MM> |

## one-liner

<filled in once classifier + research + scoper land. before that, this echoes the user's report.>

## root cause

<filled in by scoping doc. one sentence.>

## fix

<filled in by scoping doc. one sentence.>

## state

- pr: <url or "not yet">
- build: <green / red / waiting / n/a>
- review rounds used: <n / 2>
- research rounds used: <n / 3>
- human gates: scoping=<...>, email=<...>
- escalation watch (from classifier): <one-line — what would bump severity later>
- blast radius (from research): <total errors / distinct users — once research lands>
- regression hypothesis (from research): <repo@sha at ts | none>

## follow-up bugs to file

<mirrored from scoping.md after it lands. one bullet each. lead picks these up after the primary PR ships.>

- <none yet — pending scoping>

## links

- original report: ./original-report.md
- workspace: ./workspace.md
- state: ./state.json
- classifier: ./classifier.md
- reproduction: ./reproduction.md
- research: ./research.md
- scoping: ./scoping.md
- review: ./review.md
- validation: ./validation.md
- email: ./email.md

## timeline

<one line per state transition, prepended by the support lead>

- <ts> — intake
