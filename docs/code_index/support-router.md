# Code Index: Support Router and Agent Dispatch

The support router is the Slack-facing dispatch boundary for persistent agent
directives and pipeline-aware routing.

## Sources

| Symbol | File | Purpose |
|---|---|---|
| `SupportRouter` / `AgentDispatcher` | `src/support/router.ts` | Routes messages, resolves persistent agents, starts turns, and coordinates pipeline mode. |
| Directive parsing | `src/support/directives.ts` | Parses persistent-agent directives and their arguments. |
| Pipeline guard | `src/support/pipeline-guard.ts` | Keeps legacy routing and typed pipeline ownership consistent. |
| Agent identities | `src/support/agents.ts` | Public identity catalog and private overlay reload. |
| Pipeline controllers | `src/pipelines/*/controller.ts` | Typed product/bug starts when active. |

Normal commands are parsed by `src/slack/commands.ts`; persistent directives
are handled by the support router. This distinction matters for `!review`,
`!reproducer`, `!pm`, and `!build`: they may be pipeline-aware directives,
not ordinary one-shot session controls.
