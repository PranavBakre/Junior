# workspace — <bug-id>

shared chat log for this bug. every sub-agent appends its block here. junior (support lead) reads this to decide what to spawn next. sub-agents do NOT read each other's outputs directly — only this file.

other artifacts in this folder:

- `state.json` — structured machine-readable status (lead reads/writes; agents do NOT touch)
- `executive-summary.md` — one-page human view (lead updates after each agent)
- `next-agent-prompt.md` — the resolved prompt the lead is about to spawn (overwritten each spawn)
- `original-report.md` — the bug as posted
- `<agent>.md` files — each sub-agent's structured output

entry format every agent uses:

```
## [YYYY-MM-DD HH:MM] <agent-name>
**status:** <agent-specific>
**summary:** <one line>
**details:**
- ...
**questions for support-lead (optional):**
- ...
```

---
