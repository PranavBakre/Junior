# Short Follow-up Interruption and Speaker Identity

> **Status (2026-07-22):** Proposed. Planning document only; no runtime behavior has changed.

## Problem

Junior currently buffers every message that arrives while an agent is busy and drains the buffer after the active turn exits. This is safe for long-running work, but it produces poor conversational behavior when someone sends two short messages in quick succession.

For example:

1. Anshul says, `@Pranav it's working but need to update system prompt`.
2. While Junior is answering, Anshul follows with, `Will do it from Admin`.
3. Junior finishes and posts a now-obsolete clarification.
4. The follow-up is drained as another turn, creating more acknowledgements and sometimes confusing the mentioned person, Pranav, with the actual speaker, Anshul.

This has two related but independent failure modes:

- **Stale-turn behavior:** buffering a tiny correction or completion lets an obsolete response reach Slack before Junior sees the complete thought.
- **Speaker identity drift:** a Slack mention inside a message can be mistaken for the speaker or actor, even though the message's author attribution identifies someone else.

The goal is to make short conversational bursts feel like one turn without weakening the existing safety guarantees for commands, pipelines, tools, files, or long-running work.

## Confirmed Production Evidence

The identity failure was reproduced in production thread `1784636303.638319` using Claude session `9a704810-407f-471d-a0aa-b05a1e07b3b0`.

Slack received the first message from Anshul (`U0AS85CB29M`):

```text
<@U03PNSJ33S5> it's working but need to update system prompt
```

The durable pipeline prompt did not preserve Anshul as its author. Mention resolution converted the tagged user into an author-shaped label:

```text
objective: User(Pranav Bakre <@U03PNSJ33S5>) it's working but need to update system prompt

User(Pranav Bakre <@U03PNSJ33S5>) it's working but need to update system prompt

[task-follow-up]
Will do it from Admin
```

When Anshul later corrected Junior with `Nah junior he already did alot I will do it`, the next pipeline prompt contained no human attribution and duplicated the text:

```text
objective: Nah junior he already did alot I will do it

Nah junior he already did alot I will do it

[task-follow-up]
Nah junior he already did alot I will do it
```

Claude then posted `Sounds good, thanks Pranav!` through the Slack tool. This proves the failure is upstream of Slack rendering: the runner received corrupted or missing speaker identity.

The production path exposes four concrete defects:

1. `routeDirectTaskThroughDefaultRun` copies message text and timestamp into a durable assignment/outbox item but not the originating Slack user ID.
2. `dispatchAssignment` re-enters the session manager as `pipeline-internal`, so normal human-sender attribution is intentionally skipped.
3. Mention resolution renders an inline tagged user as `User(Name <@ID>)`, which resembles the normal author label when the real leading author label is absent.
4. A newly created human child assignment uses the incoming text as both `assignment.objective` and the resume payload, after which the pump appends both and duplicates the message.

The long-lived provider session amplified the defect because its prior context contained many Pranav-authored turns. The fix cannot rely on the model overcoming that history; each resumed pipeline turn must carry authoritative current-speaker identity.

## Decision

Keep buffering as the default. Add a narrow **interrupt and consolidate** path for short, same-author conversational follow-ups.

Independently, make human identity durable across the Slack → assignment → outbox → synthetic dispatch path. Interruption improves conversational timing, but it is not the identity fix: an ordinary pipeline turn must remain correctly attributed even when no interruption occurs.

A character limit alone is not sufficient. Automatic interruption is allowed only when all safety and ownership conditions pass. Everything else continues through the existing buffer-and-drain state machine.

## Eligibility Policy

The initial policy should interrupt only when:

- The active message and incoming follow-up are each at most 240 characters and 40 words.
- Both messages were sent by the same attributable human Slack user.
- The follow-up arrives within 20 seconds of the active message starting.
- Both messages route to the same top-level agent slot.
- Neither message contains files, a command, pipeline invocation metadata, internal dispatch metadata, multiline/code-heavy content, or a bot sender.
- The active run has not started a tool call or another external side effect.
- The active conversational burst has not already requested an automatic interruption.
- The manager still owns the exact active run and handle.

The policy should initially exclude persistent worker-agent sessions. They can be considered later after production behavior is understood.

Implement the decision as a pure function so thresholds and exclusions can be tested without spawning a provider:

```ts
type BusyFollowupDecision =
  | { action: "interrupt-and-consolidate" }
  | { action: "buffer"; reason: string };
```

## State Model

The manager needs enough active-turn metadata to make and settle the decision safely:

- The original input represented as a `PendingMessage`, including Slack author and timestamp.
- A unique turn generation or ownership token.
- The active turn's start time.
- Whether the turn has emitted a tool or external-side-effect event.
- Whether an automatic interruption has already been requested for this burst.
- The generation that was superseded, if any.

This state must participate in the same concurrent-safe session mutations used by pending-message append and run settlement. The implementation must not rely only on an in-memory flag: completion, message delivery, and SQLite writes can race.

## Interruption Flow

When an eligible follow-up arrives:

1. Atomically append the follow-up, mark the owned active generation as superseded, and mark the burst as already interrupted.
2. Preserve the original active message so the next turn can reconstruct the complete burst.
3. After the mutation succeeds, interrupt the exact owned handle.
4. Do not route through the broad `!stop` implementation. `!stop` clears handles and statuses for an explicit operator action and has different ownership semantics.
5. When the interrupted run settles, suppress its response if its generation is marked superseded.
6. Start one replacement turn containing the original message and all follow-ups accumulated for that burst.

If completion wins the race before interruption, the existing drain path remains the fallback. The ownership token and fresh session read must still guarantee that no stale run clobbers the replacement state.

Replaying the original message is intentional. A provider may be interrupted before it has returned a resumable session ID, so sending only the follow-up would make correctness depend on provider-specific continuity.

## Authoritative Conversation Burst

The replacement prompt should represent authors and mentions separately:

```xml
<conversation-burst supersedes-interrupted-turn="true">
  <message
    author="User(Anshul <@U_ANSHUL>)"
    mentions="User(Pranav <@U_PRANAV>)"
  >
    @Pranav it's working but need to update system prompt
  </message>
  <message author="User(Anshul <@U_ANSHUL>)">
    Will do it from Admin
  </message>
</conversation-burst>
```

The per-turn instructions must state:

- `author` is the speaker and actor for that message.
- `mentions` contains referenced or tagged people; it does not change the speaker.
- First-person and implied subjects such as “I,” “we,” and “will do it” bind to the message author unless the text explicitly names a different actor.
- The burst is authoritative and supersedes any draft from the interrupted turn.
- Junior should produce at most one response to the complete burst.

Use the same structured author/mention distinction for ordinary single-message turns where practical. The identity fix must not depend on an interruption occurring.

All untrusted values must continue through the existing delimiter escaping and Slack mention-resolution paths. The new envelope must not reopen prompt-boundary spoofing that `<buffered-message>` escaping currently prevents.

## Durable Pipeline Author Provenance

Human pipeline input needs two identities with different trust and execution roles:

- **Control-plane sender:** the synthetic `pipeline-internal` identity used to authenticate and route an internal assignment dispatch.
- **Conversational author:** the original, trusted Slack human user ID whose text the assignment carries.

Do not overload one field for both. Add explicit provenance such as `sourceSlackUserId` to human-created assignments or their durable context, and to assignment-resume outbox payloads. Capture it from the server-received `SlackMessageEvent.user`; never accept it from model-authored prompt text.

The value must survive:

```text
SlackMessageEvent.user
  → human assignment provenance
  → assignment.resume outbox payload
  → dispatchAssignment attribution input
  → SessionManager runner prompt
```

The synthetic event may continue using `pipeline-internal` for routing and authorization. Prompt construction should receive a separate `attributionUserId` (or equivalent trusted field) and use it for the structured message author. This avoids making a human ID look like the internal control-plane caller.

For non-human assignments and legacy rows without author provenance, omit the author rather than guessing from mentions, thread participants, prior pipeline ownership, or memory.

### Assignment context

`source_agent: human` is too coarse to identify the speaker. The assignment context should include a dedicated field when known:

```text
source_agent: human
source_slack_user_id: U0AS85CB29M
```

The human-readable objective must still be wrapped in an authoritative message envelope. Metadata alone is insufficient if the actual prompt body remains bare.

### Author and mention rendering

Author rendering and mention rendering must use visibly different syntax. For example:

```xml
<human-message author="User(Anshul <@U0AS85CB29M>)">
  <mentions>User(Pranav <@U03PNSJ33S5>)</mentions>
  <text>@Pranav it's working but need to update system prompt</text>
</human-message>
```

Alternatively, inline mentions can render as `Mention(Name <@ID>)` rather than `User(Name <@ID>)`. Whichever representation is chosen, a mentioned user must never be syntactically indistinguishable from the message author.

The author-versus-mention rule must be injected on every relevant turn, including resumed provider sessions and synthetic pipeline dispatches. Today the full Slack instruction block is primarily a first-turn/catch-up concern, which is insufficient for long-lived sessions whose current input arrives through a different envelope.

## Follow-up Composition Without Duplication

The outbox pump currently builds an assignment-resume prompt as:

```text
assignment.objective

[task-follow-up]
payload.prompt
```

That is correct when the assignment already existed and `payload.prompt` is genuinely new. It is wrong when a new human child assignment was created from that same message: the objective and follow-up are identical.

Define the two cases explicitly:

- **Existing assignment wake:** retain the existing objective and append the new, attributed human follow-up.
- **New child assignment:** use the attributed objective once; do not append an identical follow-up block.

Avoid solving this with loose text deduplication after prompt composition. The assignment creation path already knows whether it created a child or resumed an existing assignment and should encode that semantic distinction in the outbox event or payload.

## Response Suppression

Before posting a completed response, the manager must re-read the current generation and ownership state.

If the completing generation was superseded:

- Do not post its response.
- Do not emit a stale clarification, waiting message, completion recap, or agent-settled notification based on that response.
- Preserve any internal bookkeeping required to resume or cold-start the provider.
- Allow only the consolidated replacement turn to produce the conversational response.

Existing duplicate Slack-tool-post suppression remains in force. If the consolidated burst only acknowledges information and no response is useful, the normal `NO_SLACK_MESSAGE` policy should be preferred over another recap.

## Provider Boundary

The manager owns the product policy; provider adapters own the interruption mechanism.

- Persistent drivers should halt only the current turn and retain the underlying session.
- Headless providers may interrupt the owned process, then resume when a valid provider session is available.
- Providers without reliable interruption or continuity must return a capability result that makes the policy fall back to buffering.
- The consolidated prompt always includes the original message, so correctness does not require interrupted-turn history to have been persisted by the provider.

Do not add provider-specific branching directly to the conversational policy function.

## Configuration and Rollout

Introduce conservative configuration with defaults similar to:

```env
SESSION_SHORT_FOLLOWUP_INTERRUPT_ENABLED=false
SESSION_SHORT_MESSAGE_MAX_CHARS=240
SESSION_SHORT_MESSAGE_MAX_WORDS=40
SESSION_SHORT_FOLLOWUP_WINDOW_MS=20000
```

Recommended rollout:

1. **Shadow mode:** evaluate and log decisions without interrupting.
2. Review how often messages qualify and why candidates are rejected.
3. Enable for a small production scope.
4. Confirm that stale-response count falls without increasing duplicate side effects or interrupted useful work.
5. Expand gradually; tune thresholds only from observed conversations.

Useful structured reasons include:

- `interrupt.short-followup`
- `buffer.different-author`
- `buffer.side-effect-started`
- `buffer.too-long`
- `buffer.outside-window`
- `buffer.already-interrupted`
- `buffer.provider-unsupported`

## Verification Plan

### Policy tests

- Two eligible short messages from the same human select interruption.
- Different authors, long content, files, commands, bots, pipelines, and internal dispatches select buffering.
- A turn that has started a tool or external side effect selects buffering.
- A second follow-up in the same burst does not trigger a second interruption.

### Session-manager tests

- The Anshul/Pranav example preserves Anshul as author for both messages and records Pranav only as mentioned.
- A human message entering an active durable run persists its trusted Slack user ID through the assignment and outbox dispatch.
- Synthetic pipeline dispatch retains `pipeline-internal` as its control-plane sender while presenting the original human as the conversational author.
- A newly created human child assignment includes its message exactly once.
- Waking an existing assignment includes the existing objective plus exactly one newly attributed follow-up.
- A legacy pipeline assignment without `sourceSlackUserId` remains unattributed instead of inferring an author from mentions or prior participants.
- Author and mention labels remain distinguishable after Slack mention resolution.
- Resumed provider turns receive the author-versus-mention contract even when the full first-turn Slack preamble is omitted.
- Two short same-author messages produce one interruption, one consolidated prompt, and at most one Slack response.
- Three quick messages trigger at most one interruption and appear in order in the consolidated burst.
- A completion-versus-interrupt race never posts both the stale response and the consolidated response.
- An interruption before provider session-ID capture still replays the original and follow-up messages.
- Muting, resetting, cancelling, and explicit `!stop` retain their current semantics.
- Top-level and persistent-agent ownership remain isolated.
- SQLite round-tripping preserves any durable metadata needed for safe settlement.
- Delimiter escaping prevents a message body or display name from forging a conversation-burst boundary or author.

### Integration verification

- Run the relevant session-manager and provider-adapter tests.
- Run the full typecheck and test suite.
- Exercise at least one provider with continuity and one headless provider.
- Verify Slack shows one coherent response for a short conversational burst and no response from the superseded turn.
- Complete two consecutive clean verification passes before committing.

## Expected Code and Documentation Surfaces

- `src/session/types.ts` — active-turn and supersession metadata.
- `src/session/manager.ts` — eligibility gate, atomic supersession, response suppression, consolidated replay.
- `src/runners/types.ts` and provider adapters — explicit interruption capability if the existing boundary is insufficient.
- `src/config.ts`, `.env.example`, and config tests — feature flag and thresholds.
- `src/slack/thread-context.ts` — authoritative author-versus-mentions prompt contract.
- `src/pipelines/types.ts` and pipeline stores — durable human Slack-author provenance.
- `src/pipelines/dispatch.ts` — separate synthetic control-plane sender from conversational attribution.
- `src/pipelines/pump.ts` — preserve resume provenance and avoid new-child objective/follow-up duplication.
- `src/pipelines/context.ts` — expose trusted human provenance in assignment context without treating it as the prompt envelope.
- `src/session/manager.test.ts` and store tests — policy, race, persistence, and identity coverage.
- `docs/features/session-management.md` and `docs/features/thread-context.md` — shipped behavior after implementation.
- `CLAUDE.md` — replace the unconditional “Buffer, don't interrupt” rule with the narrow short-follow-up exception after the behavior ships.

## Coordination Note

Before implementation, inspect and reconcile the changes from the other active sessions. The highest-conflict files are likely `src/session/manager.ts`, `src/session/types.ts`, and `src/session/manager.test.ts`. Do not overwrite or revert unrelated work, and do not update the shipped-behavior documentation until the runtime change is actually implemented and verified.
