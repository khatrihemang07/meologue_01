# 0034: Reflection reports its progress as it runs

## Status

Accepted. Depends on [0031](0031-reflection-is-a-loop-over-tools.md) — there is nothing to report
progress *of* without a loop that takes more than one step. Built in two passes: issue #96 pass 1
(`fc23438`) is the wire; pass 2 (`871b00b`) is the client reading it. Two follow-ups landed the
same day: `f2db2c3` (pluralisation in a live step label) and `1d95d59` (a failed stream says why
instead of vanishing).

## Context

`0031`'s loop can now take several tool calls and several model replies to answer one Question,
each costing real, visible time — the chat endpoint alone costs roughly seven seconds per call.
Before this ADR, `POST /v1/reflect` was a single JSON response: the client had nothing to show
while the loop ran except a static "Searching your Entries…" label for a few seconds, then
"Thinking…" until the whole run finished, however many steps it actually took. That label was
already a fiction once a Question could take three tool calls in sequence — the interface had no
way to say which search ran, what it looked for, or how many Entries came back, because none of
that existed anywhere the client could see it until the entire run was over.

## Decision

**`POST /v1/reflect` becomes `text/event-stream`.** As the loop runs, it emits pi's own event
vocabulary — `turn_start`, `message_start`, `message_update`, `message_end`,
`tool_execution_start`, `tool_execution_end`, `agent_end` — so the interface can say which search
ran, what it looked for, and how many Entries came back, while it is happening rather than after.
A two-step Question produces:

```
turn_start → message_start → message_end
           → tool_execution_start → tool_execution_end
turn_start → message_start → message_end → agent_end
```

`agent_loop::LoopEvent` is where this vocabulary is actually produced (see
[0031](0031-reflection-is-a-loop-over-tools.md)), and it is deliberately wire-agnostic: turning one
`LoopEvent` into an SSE frame — an `event:` name, a JSON `data:` payload — is `reflect.rs`'s job
alone (`loop_event_to_sse`), the one place that already owns every other wire-shape decision
`/v1/reflect` makes. `agent_loop` itself never learns it is talking to a stream at all.

**`message_update` carries answer-token deltas, and only appears when the underlying
`ChatClient` actually emits them.** `PromptedToolClient` ([0032](0032-tool-calls-are-carried-in-the-prompt-not-the-wire.md))
never does — `codex-terra` cannot stream, so on the configured model this event never appears and
the Answer arrives whole inside `message_end`. The forwarding path itself is generic and
unit-tested against a scripted streaming client, so a model that genuinely streams (`claude-*`,
issue #98) needs no further work here to light up token-level updates: "built once, both work."
Issue #98 also recorded, live, that "streaming" from `claude-*` is not token-level either — the
Claude Agent SDK emits message-sized chunks (a 20-item count came back as two chunks of 27 and 123
characters) — so in practice `message_update` today means "answer text appears progressively in a
small number of pieces," not "token by token," on every model this Server has actually been
verified against.

**`tool_execution_end` carries `tool_name`, `is_error`, `entry_ids`, the `details` sidecar issue
#95 established, and an explicit `entry_count`.** `entry_count` falls back to
`details.grounding_entry_ids` for `read_digest`, the one tool that deliberately populates no
`entry_ids` because a Digest is not an Entry (`tool_entry_count`, `reflect.rs`) — without this
fallback, a Digest lookup that found real content would report 0 Entries regardless of what it
actually surfaced.

**One `PROTOCOL_VERSION`, shared across `/v1/sync`, `/v1/reflect`, and `/v1/health`, moves to
3.** [0002](0002-sync-cursor-server-assigned-sequence-advisory-lock.md) established this constant
behind Sync; this ADR is the second time a change to Reflection alone has moved it (the first,
[0023](0023-reflection-is-a-fixed-three-source-fan-out.md), deliberately did *not* move it, using
`#[serde(default)]` instead — this ADR's change is a genuine wire-shape break for a route that has
no additive-field escape hatch once it becomes a stream). A Device is one build that either speaks
version 3 or does not: the alternative, a second version constant scoped to `/v1/reflect` alone,
would be more machinery than the problem deserves, and a mismatch on either route stays the same
clean `426` it already was. `packages/core`'s constant moves with it, and two source comments that
had claimed the version "stays 1" were already wrong by the time this ADR's code landed and are
now corrected.

**A failed Question can no longer be a 500, because the stream has already committed to 200 by
the time the loop runs.** The Session is resolved synchronously *before* the stream opens — an
unknown Session id is still a real 404, an unconfigured chat endpoint is still a real 404, and a
stale `protocol_version` is still a real 426, all ahead of any SSE framing. Once the stream is
open, every failure the loop can produce becomes exactly one terminal `agent_end` frame carrying
`status: "error"`, then the stream closes — never a hang, never a bare dropped connection a client
cannot distinguish from a network failure. Issue #102's guarantee is untouched by this: `NonEmptyAnswer`
still gates `record_turn_from_steps`, so a run that produces no Answer still persists nothing to
the Session, whether it failed before or after this ADR's stream framing existed.

**`GET /v1/models` proxies the wrapper's own model list**, reusing `llm.rs`'s existing fetch
rather than adding a second one, and degrading to an empty list when the wrapper is unreachable
rather than failing the page — this is issue #98's feature (a Conversation choosing its own
model), riding this ADR's wire change because both needed a place on `/v1/reflect`'s surface.

**The disclosure the client renders retreats from asserting a verdict to stating a fact it can
actually verify.** `GroundingDisclosure`'s `summaryLabel` produces exactly one wording now — "N
Entries returned" — never "Grounded in N Entries." This is not a wording preference; it is the
direct consequence of `grounded` leaving the vocabulary
([0031](0031-reflection-is-a-loop-over-tools.md)'s Consequences covers the Grounding-definition
question this raises for CONTEXT.md). The old wording was caught actively misleading, not merely
imprecise, on the live Sandbox: asked "What did I think of the football match?" — a topic present
nowhere in the journal — the loop behaved correctly (`search_entries` returned 0,
`similar_entries` returned its unconditional top-k anyway, since issue #92 removed the similarity
floor, and the model answered "I couldn't find any journal entry about a football match") while the
interface printed "Grounded in 30 Entries" directly beneath that correct answer, because the old
label counted ids rather than reading any verdict. Since #92, `similar_entries` returning a
nonzero top-k for *every* Question, present topic or absent, is the common case, not an edge one —
so this was not a rare misfire, it was what the old label would say on nearly every "nothing
found" Answer. "N Entries returned" states only what the component actually knows: a tool call
found this many and the model read them. Whether the Answer rests on any of them is left to the
Answer's own words, which is exactly CONTEXT.md's don't-invent rule applied consistently rather
than partially.

**A Digest-sourced Answer is now visible in the disclosure, live and after reload.** Issue #95
tagged a Digest tool result's `details` with `"source": "digest"` and deliberately populated no
`entry_ids`, which meant the old disclosure rendered nothing at all for it. Driven from `details`
directly, it now reads "Answered from the week Digest for 2026-08-17 to 2026-08-23" — live from
this ADR's pass 2, and after reload once [0033](0033-a-session-is-an-append-only-entry-tree.md)'s
`entries_to_turns` started deriving `digest_source` from the tree.

## Alternatives considered

- **Poll `GET /v1/sessions/{id}` on an interval instead of streaming.** Rejected: it would show a
  completed Turn appearing, not the loop's own live progress — there is no per-tool-call detail on
  that endpoint to poll for mid-run, and building one would duplicate the event vocabulary SSE
  already gives for free from the loop that's already producing it.
- **A second `PROTOCOL_VERSION`-shaped constant scoped to `/v1/reflect` alone**, leaving Sync's
  version untouched. Rejected on the same reasoning [0025](0025-sessions-are-held-by-the-server.md)
  used for its own `PROTOCOL_VERSION` question: one constant behind all three routes is the honest
  model of what a single Device build actually is, and a second constant is more moving parts than
  the problem deserves.
- **Keep the old response shape and add a parallel `GET /v1/reflect/{id}/events` polling
  endpoint for progress only.** Rejected: two endpoints for one logical operation, with the two
  having to agree on when the operation is actually finished — SSE with one terminal `agent_end`
  frame is a single source of truth for "this run is over" that a split design would have to
  reconstruct.
- **Fail a broken run by simply closing the connection, with no terminal frame.** Rejected: a
  client cannot distinguish a deliberate close from a dropped network connection, which is exactly
  the ambiguity a synchronous 500 used to avoid and a silent close would reintroduce. The terminal
  `agent_end{status: "error"}` frame exists specifically so failure is always a recognisable event,
  never a guess.

## Consequences

**Every Device now needs the version-3 wire shape to use either Sync or Reflection at all**, since
the one shared `PROTOCOL_VERSION` gates both — a Device that predates this ADR sees a `426` on
both routes, not just Reflection, until it upgrades. This is the accepted cost of one constant
being the honest model rather than two independently-versioned ones.

**A client has to parse SSE frames that can arrive split across any chunk boundary**, including
mid-frame and mid-separator — `reflect-transport`'s frame parser is written and tested against
exactly that, the same rigor [0032](0032-tool-calls-are-carried-in-the-prompt-not-the-wire.md)'s
`ToolCallScanner` applies to tag boundaries, for the same underlying reason: nothing about a
network transport guarantees a frame arrives whole.

**A run that fails after the stream has already committed to 200 renders identically, from the
client's point of view, to a run that never produced an Answer for any other reason** — it shows
no Turn at all and restores the Question to the composer, which is correct precisely because issue
#102's guarantee means the Server persisted nothing either way. The client has to actively
distinguish "stream failed to open" (genuinely unreachable) from "stream opened, ran, and reported
`status: error`" (the server tried and the run failed) to render the right message, since both are
now real, sometimes-occurring outcomes rather than one being conflated with a hard network failure.
