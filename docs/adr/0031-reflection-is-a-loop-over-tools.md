# 0031: Reflection is a loop over tools

## Status

Accepted. Supersedes [0023](0023-reflection-is-a-fixed-three-source-fan-out.md) (the fixed
three-source fan-out, its merge rule, and `MIN_SIMILARITY` — already deleted by issue #92 and
recorded in 0023's own Status) and [0024](0024-the-answering-call-judges-its-own-grounding.md)
(the `GROUNDED` verdict and the disclosed 3-day fallback). [0026](0026-the-extraction-call-sees-the-conversation.md)
is superseded with them, since the extraction call it amended no longer exists. Extends
[0025](0025-sessions-are-held-by-the-server.md) — everything 0025 decided about where a Session
lives and how it's addressed stands; [0033](0033-a-session-is-an-append-only-entry-tree.md)
records the one piece 0025 got wrong about what a Session is *made of*. Extended by
[0032](0032-tool-calls-are-carried-in-the-prompt-not-the-wire.md) (how a tool call actually
reaches the model) and [0034](0034-reflection-reports-its-progress-as-it-runs.md) (how the loop's
progress reaches the client).

## Context

0023 built Reflection as two chat calls and three concurrent retrievals: extract a date range and
a keyword from the Question, run all three searches once, merge/dedupe/cap at 40, hand the result
to one answering call. 0024 added a self-reported `GROUNDED: yes/no` marker to that answering
call, because nothing else in the request read what retrieval actually found next to the
Question. Both ADRs record, in detail, what that shape could not do: `docs/adr/0026`'s "how has my
knee been this year" / "did I keep running through it?" pair, unresolvable because the extraction
call couldn't see the Conversation; and, more fundamentally, a design that can only search *once*
per Question, no matter how wide or how oblique it is.

Issue #90's eval harness put a number on it before any redesign code existed:
`tests/eval-retrieval-baseline.md` records mean recall 0.319 across 22 Questions against the live
Sandbox corpus, with 7 scoring exactly zero — and the finding that mattered was not that recall
was low, it was that the score tracked *phrasing*, not topic: "Did I mention a trip to Japan
anywhere?" cleared the floor five times over for a topic entirely absent from the journal, while
"what did I write about Priya's wedding" returned nothing for a topic that is present, worded
differently. A single fixed retrieval, run once, has no way to recover from having asked the wrong
question of the index the first time.

A prototype loop — run against the same corpus, same models, no floor — answered correctly and
grounded, including "compare what I wrote about my knee in July versus August," which the fixed
shape cannot answer at any retrieval quality because it does one retrieval round into one merged
set and never looks again. That prototype is what this ADR records as shipped.

## Decision

**`/v1/reflect` runs `harness::agent_loop::run` (issue #93): the model is told what tools exist,
asks for one, reads the result, and asks again until it has enough, then answers in prose. Nothing
decides in advance how many searches a Question deserves.** This is a close port of
`earendil-works/pi`'s `packages/agent/src/agent-loop.ts` (`runLoop`), and the load-bearing parts
are the ones that read like implementation detail and are not:

**Tool calls are detected by inspecting the reply's content, never by trusting a stop reason.**
`agent_loop::run`'s own doc comment states this as pi's rule reproduced verbatim: tool calls are
read off `AssistantMessage::content` (a filter over `ContentBlock::ToolCall`), not off
`StopReason::ToolUse`, which `harness::prompted` computes only as a derived convenience for its
own callers. This matters concretely under [0032](0032-tool-calls-are-carried-in-the-prompt-not-the-wire.md):
there is no genuine tool-calling stop reason to trust in the first place, so the loop's stopping
rule is written against the one signal that is actually reliable regardless of what sits
underneath `chat::ChatClient`.

**A reply with no tool call ends the loop, and its text *is* the Answer — there is no separate
answer tool to forget to call.** `LoopOutcome::answer` is `Some(text)` exactly when the loop ends
this way; every other exit (`Error`/`Aborted`, unanimous `terminate`, `should_stop_after_turn`)
returns `None`. This is pi's own definition of "done" (`message.content.filter(toolCall).length
=== 0`), and it is why nothing in this design has a `GROUNDED` marker or any other verdict the
model has to remember to emit correctly: the ordinary act of finishing — writing prose with no
tag — is the entire contract.

**`terminate: true` on a tool result requires unanimity across the whole batch before it stops the
loop.** `run_inner`'s own comment names this precisely: `finalizedCalls.every(f =>
f.result.terminate === true)`, pi's `shouldTerminateToolBatch`. A reply can carry several tool
calls in one turn (the model does this unprompted — see Consequences), and one of them wanting to
stop must not cut off a batch where another call is still mid-result. A dedicated test
(`terminate_on_one_of_two_results_does_not_stop_the_loop`) proves this by construction: one
terminating result out of two must not stop the loop.

**There is no step budget.** pi ships none, and this is deliberate, not an oversight — a Question
that genuinely needs five searches should get five, and nothing in this design decides in advance
how many a Question deserves. The real backpressure pi relies on, and this port reuses, is
per-tool output caps plus compaction, not a turn count:

- Every tool (`entries_in_range`, `search_entries`, `similar_entries`, `read_digest`) pages its own
  results: `DEFAULT_PAGE_SIZE` 20, `MAX_PAGE_SIZE` 100 (hard cap via `limit`), `CONTENT_CHAR_BUDGET`
  8,000 characters — whichever bites first. A truncated page names the exact next call
  (`[Showing 1-20 of 47. Use offset=21 to continue.]`); a complete page says nothing at all, which
  is the actual signal — silence is how the model knows it has everything, and the absence of that
  string is tested explicitly (`tools/mod.rs`), not just its presence.
- [0034](0034-reflection-reports-its-progress-as-it-runs.md) covers what a long-lived Session costs
  and how [compaction](0025-sessions-are-held-by-the-server.md) (issue #97) keeps a Conversation's
  own prompt bounded regardless of how many Turns it accumulates.

`LoopConfig::should_stop_after_turn` (`ShouldStopAfterTurn`) exists as an unused hook — pi's own
`shouldStopAfterTurn` — precisely so a future cap (a step budget, a wall-clock timeout) can be
layered on without touching `run`'s control flow to make room for it. Nothing today passes one;
`reflect.rs` always passes `None`.

**The evidence for "no step budget" being the right call, not merely the port being faithful**:
verified end to end against the seeded corpus and the real model, "Compare what I wrote about my
knee in July versus August" made three tool calls, and the second and third were `offset=40` and
`offset=83` — the model read its own tool's continuation hint and paged itself, twice, unprompted,
across a cross-period comparison the fixed pipeline could not produce at any retrieval quality. No
fixed number of allowed searches, chosen ahead of time, would have been guaranteed to cover that
Question and not waste budget on a one-search Question asked five minutes later.

**Every failure a tool call can produce becomes a result the model reads on its next turn, never a
failed Question.** `run_one_tool_call` is deliberately the only place a tool call can fail: an
unknown tool name, the empty-name sentinel `prompted.rs`'s scanner produces for an unparseable
`<tool_call>` tag, or `AgentTool::execute` returning `Err` all funnel into an ordinary `is_error:
true` result. This is pi's own rule (`prepareToolCall`'s `createErrorToolResult`), reproduced
because a request built entirely from a model's own text output (0032) has no schema enforcement
underneath it to catch a malformed call before it happens — recovery has to be the model's job on
its next turn, not a Server-side crash.

**Tools execute sequentially, not pi's parallel dispatch.** Issue #93 calls this out directly:
`executeToolCallsParallel` is not worth porting for four cheap, SQL-backed tools
(`entries_in_range`, `search_entries`, `similar_entries`, `read_digest`) where the win would be
milliseconds against calls that already cost effectively nothing next to the surrounding chat
call's ~7 seconds.

**`grounded` and `fallback_used` leave the vocabulary entirely.** Both were the fixed pipeline's
own concepts — `grounded` was a verdict the Server extracted from the model's wording about a
merged set computed in advance; `fallback_used` marked whether the disclosed 3-day consolation
answer had fired. Neither has a referent under the loop: the model now stops when it is satisfied
with what it has read, rather than being handed one fixed pile of Entries and asked to grade it,
so there is no single moment where "was this grounded" could be evaluated even in principle. Issue
#99's own text says this precisely: the loop makes the question meaningless, not merely harder to
answer.

**`grounding_entry_ids` stops being a computed merge and becomes "the Entry ids that appeared in a
tool result during this Turn," in the order they first appeared.** `sessions::entries_to_turns`
reads this directly off the tree's own `tool_result` entries — nothing is deduped, ranked, or
capped at read time beyond what the tools themselves already returned. This is a strictly weaker
claim than the old field made, and that is the point:
[0034](0034-reflection-reports-its-progress-as-it-runs.md) covers what the client says about it
now that it can no longer claim relevance, only presence.

## Alternatives considered

- **Recalibrate or extend the fixed three-source fan-out instead of replacing it** — a fourth
  retrieval source, a smarter merge rule, a better-tuned `MIN_SIMILARITY`. Rejected on the same
  evidence 0023 and 0024 already accumulated against this shape: the problem was never which
  sources were fanned out or how they were merged, it was that a Question only ever got to ask
  once. No merge rule recovers a Question whose first (only) search phrased things in a way the
  index didn't reward — the knee/July-vs-August comparison needs two distinct searches with
  different arguments, not a wider single one.
- **Give the fan-out a second round, decided by a fixed rule** (e.g., "if the merged set is thin,
  try again with the keyword alone"). Rejected as complexity without the actual property wanted:
  every such rule is a guess about which Questions need a second look, made by whoever wrote the
  rule instead of by whatever turns out to need it live. A loop that asks the model when it has
  enough is a general answer to a problem no fixed heuristic covers completely.
- **A step budget, chosen up front (e.g., cap at 5 tool calls).** Rejected — see Decision. pi ships
  none, and issue #93 measured a case (the knee comparison) that took exactly 3 calls with no way
  to know that number in advance; a budget picked to cover it comfortably is either too generous
  for the common one-call Question or too tight for the next Question that needs more than 3.
  `should_stop_after_turn` is kept as the seam for whoever eventually needs one, rather than a
  number invented now with no measurement behind it.
- **Parallel tool dispatch**, porting pi's `executeToolCallsParallel` faithfully. Rejected on cost:
  not worth the added complexity (ordering guarantees, error aggregation across concurrent calls)
  for four SQL-backed tools whose own latency is negligible next to the chat call around them.

## Consequences

**Latency is now proportional to how much a Question actually needs, not fixed at two calls.** A
Question answerable from one search costs one tool call and two chat turns, same order of
magnitude as the old pipeline; a Question that needs several searches costs proportionally more,
in exchange for being answerable at all. This trades a predictable-but-wrong latency for a
variable-but-correct one.

**Nothing in this design can any longer assert that an Answer is "grounded."** This is the direct
consequence of `grounded` leaving the vocabulary, and it raises a question worth answering plainly
rather than leaving implicit: **does CONTEXT.md's own Grounding entry need to change along with
it?**

CONTEXT.md defines Grounding as "the Entries Reflection found relevant to a Question and used as
the basis for its Answer." Under the loop, the Server genuinely cannot verify the second half of
that clause — it knows a tool call returned some Entries and that the model read them in a later
turn, not which of them, if any, the final Answer actually rested on. Issue #99's own commit
(`6bed6b5`) already drew the consequence for the interface: the disclosure label changed from
"Grounded in N Entries" to "N Entries returned," because the old wording asserted a relationship
between the Answer and those Entries the Server has no way to know holds.

**The verdict here is that CONTEXT.md's Grounding entry does not need to change, and the fix that
already shipped is the correct one.** Three reasons:

1. Grounding, as CONTEXT.md defines it, is a property of the Answer's own reasoning — an epistemic
   fact about what the model actually leaned on — not a set the Server computes. That was already
   true before this ADR: even 0024's `GROUNDED` marker was a single yes/no verdict over the whole
   merged set, never a per-Entry attribution telling you which specific Entries among the merged
   forty actually mattered. The loop makes the Server's approximation of Grounding worse (it now
   has none at all, where before it had a self-reported binary judgment), but it does not change
   what Grounding *is*; it changes how much of it the Server can honestly claim to observe.
2. The behavioural half of the definition — "an Answer with no Grounding behind it says so
   plainly rather than filling the gap from somewhere else" — is what actually does work in this
   codebase, and it is unaffected by this ADR. `LOOP_SYSTEM_INSTRUCTION` states the don't-invent
   rule in CONTEXT.md's own words, and issue #103 (`1b95b5a`) hardened it further: a run that
   produces prose with zero tool calls is now caught structurally and given one corrective turn,
   because a model that never looked has no basis to claim either an answer or an absence. That is
   CONTEXT.md's Grounding rule holding under the loop, not failing under it.
3. Retreating the disclosure to "N Entries returned" is the honest response to an observability
   gap, not evidence the underlying concept was wrong. A claim being hard to verify from outside
   is not the same as the claim being incoherent — the Answer's text is still expected to be
   honest about what it does and doesn't know, exactly as before; what changed is only that the
   Server stopped attaching an unverifiable badge to whatever a tool happened to return nearby.

If a future ticket wants the Server to *reconstruct* a real per-Entry Grounding signal (for
instance, by asking the model to cite which of the Entries it read actually informed the Answer),
that is a new mechanism to design and measure, not a reason to redefine the term it would be
measuring.

**`Turn` needs its meaning stated plainly, because this ADR pulls two established usages of the
word apart.** `docs/adr/0025` used "Turn" informally for a whole Question/Answer exchange (and
`sessions.rs`'s `SessionTurnRow`, `record_turn`, and `reflect.rs`'s `prior_turns` all still carry
that meaning — see [0033](0033-a-session-is-an-append-only-entry-tree.md)'s own note on this).
`agent_loop`'s own vocabulary (`LoopEvent::TurnStart`, ported directly from pi and exposed on the
wire in [0034](0034-reflection-reports-its-progress-as-it-runs.md) as the `turn_start` SSE event)
names one iteration of the loop — one model reply, plus whatever tool calls that reply contained.
Those are not the same thing: a single Question/Answer exchange can now take several loop Turns.
CONTEXT.md is updated to define Turn as the loop-iteration meaning, per issue #99's own
instruction — see CONTEXT.md's own entry, and this ADR's cross-reference to the naming
inconsistency this leaves in the Rust identifiers that still use the older sense.
