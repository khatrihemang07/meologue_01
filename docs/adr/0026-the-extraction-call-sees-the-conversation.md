# 0026: The extraction call sees the Conversation it is part of

## Status

**Superseded by [0031](0031-reflection-is-a-loop-over-tools.md): the extraction call this ADR
amends no longer exists.** Issue #99 (`6bed6b5`) removed it along with the rest of the fixed
pipeline ([0023](0023-reflection-is-a-fixed-three-source-fan-out.md)'s own Status) — the loop's
tools each carry their own arguments the model chooses per call, so there is no longer a separate
pre-search step whose job was to guess a date range and a keyword ahead of time, and therefore
nothing left for that step to need a Conversation window for. The problem this ADR solved — a
follow-up Question whose referent lives in the Conversation before it — is instead solved by the
loop reading the whole replayed Conversation directly when it decides what to search for on each
turn, which is a structural fix rather than a widened window on a call that no longer exists. Kept
in full below as the record of a real gap, correctly diagnosed. Everything below this line
describes code that no longer exists.

Accepted. Extends [0023](0023-reflection-is-a-fixed-three-source-fan-out.md) — the fixed
three-source fan-out, the merge rule, the priority order, the cap, and `MIN_SIMILARITY` as a cheap
noise filter all stand exactly as that ADR left them, as does its floor that any extraction failure
degrades to "no range, no keyword" rather than failing a Question. What this ADR changes is one
clause: 0023 built the extraction call from the system prompt and the current Question alone. It now
also sees the recent Conversation. 0023 is cross-linked back to this ADR at the place it made that
claim.

## Context

0023 split Reflection's retrieval into three sources, two of which depend on a first chat call that
reads a Question and extracts a date range and a keyword from it. That call was given the Question
and nothing else.

That was reasonable when it was written, and the reason it looked reasonable is worth naming: a
Conversation lived in memory and died on reload, so almost every Question was a first Question. A
retrieval step that only reads the current Question loses nothing when there is nothing before it.

[0025](0025-sessions-are-held-by-the-server.md) made Sessions durable and reachable from every
Device. Follow-ups stop being rare and become the ordinary way the feature is used — which turns a
gap that was nearly invisible into the common case.

The gap is that Reflection is context-aware in one half and context-blind in the other. The
answering call has always received the prior Turns, so it knows what the user meant. The call that
decides *what to retrieve* did not, so it worked from a string that may not mean anything on its
own. Asking "How has my knee been this year?" and then "Did I keep running through it?" gives the
second Question no way to know what "it" is; retrieval goes looking for nothing in particular, and
the answering call — however well it understands the follow-up — can only work with what retrieval
put in front of it. Observed live on the 572-Entry corpus while verifying 0025: that exact pair
returned `grounded: false` and fell into the disclosed fallback, not because the Answer was
unknowable but because the Entries that held it were never retrieved.

## Decision

**The extraction call receives the same recent-Conversation window the answering call gets.** One
constant, `CONVERSATION_WINDOW`, bounds both. There is no second, differently-sized window to keep
in step: the two calls are reading the same Conversation for the same reason, and a follow-up that
reaches back further than the answering call can see would be resolved against context the Answer
could not then use anyway.

**The Conversation is rendered as compact `Q:`/`A:` prose inside the extraction call's system
prompt, not as real `user`/`assistant` turns.** This is the load-bearing mechanical choice.
Everywhere else in Reflection, prior Turns are replayed as genuine role-tagged turns, because the
answering call is *supposed* to continue a conversation in prose. The extraction call is the
opposite: its entire contract is to emit one small JSON object and nothing else. Handing it a real
`assistant` turn containing a paragraph of prose is an invitation to reply with another paragraph of
prose, and 0023 already established that this endpoint offers no structured-output mode and no tools
to fall back on — the JSON discipline is held by the prompt alone. Keeping the Conversation inside
the system message preserves the two-message shape the call has always had, and the JSON-only
instruction is repeated *after* the Conversation block so that it is the last thing read no matter
how long the Conversation grows.

**The Conversation block is omitted entirely for a first Question, rather than included empty.** A
fresh Session's extraction call is what it was before this ADR. This keeps the common case unchanged
rather than making every Question pay for a feature only follow-ups need, and it means a regression
in first-Question extraction cannot be caused by this change.

**0023's floor is untouched, and no new failure path is added.** Everything this call can do wrong —
returning prose, returning nothing, erroring, returning a nonsensical range — still degrades to
`Extraction::default()`, which makes the fan-out behave exactly as it did before extraction existed.
A step that exists to widen recall must never be able to narrow it to zero. Feeding it more context
enlarges what it can get *right*; it cannot enlarge what it can break.

**The call count does not change.** Reflection stays two chat calls normally and three when the
disclosed fallback fires. This ADR buys better retrieval out of a call that was already being paid
for, which is the reason it is worth doing at all.

## Alternatives considered

- **A dedicated call that rewrites a follow-up into a standalone Question first.** The textbook
  approach, and it would produce a cleaner input than any amount of context-stuffing. Rejected on
  the cost argument 0024 already made in the same place: this endpoint costs roughly seven seconds a
  call, Reflection is already two deep and sometimes three, and a fourth would be paid on every
  Question — including every first Question, which needs no rewriting at all — to serve follow-ups.
  - **Passing only the previous Question, not its Answer.** Cheaper and shorter. Rejected because
  the referent frequently lives in the Answer rather than the Question: "did that get better?" after
  an Answer that named a specific injury is resolvable only from the Answer's text. - **Passing the
  entire Conversation rather than a window.** Rejected for the same reason the answering call is
  capped (see [0025](0025-sessions-are-held-by-the-server.md)'s Consequences): a durable Session
  grows without bound, and an unbounded prompt against an endpoint with no timeout is a slow-motion
  failure rather than a loud one. - **Doing nothing, and relying on the answering call's own
  understanding.** Rejected because it mistakes where the loss happens. The answering call does
  understand the follow-up; what it lacks is the Entries, and those were never fetched. No amount of
  comprehension downstream recovers a retrieval that looked for the wrong thing. - **Adding
  structured output or a tool definition to make the JSON contract robust enough to tolerate prose
  turns.** Not available: 0023 recorded that the wrapper accepts only `model`, `messages` and
  `stream`, and every model behind it reports `"tools": false`.

## Consequences

The extraction call's prompt now grows with the Conversation, up to the window. Its latency and
token cost rise with it — modestly, since it reads a bounded number of Turns and returns a tiny
object, but this call used to be nearly fixed-size and no longer is.

**A follow-up can now be extracted wrongly in a way it previously could not.** Reading "the week
before that" against the wrong antecedent produces a confidently wrong date range, where before it
produced no range at all. The floor means the failure is bounded — a wrong range still merges behind
the question search, which is why the merge order in 0023 is priority-ordered rather than
chronological — but "no extraction" and "wrong extraction" are genuinely different failure modes and
this ADR trades some of the first for some of the second. That trade is worth making because the
first mode fails silently on every follow-up, while the second requires the model to misidentify a
referent that is written down directly above it.

The JSON contract is now defended by prompt structure rather than by the prompt being short. If a
future change reorders that prompt and lets the Conversation block fall after the JSON instruction,
the failure will be a parse failure that degrades quietly to question-only retrieval — the same
silent degradation this ADR exists to remove. The ordering is deliberate and should not be treated
as incidental formatting.

Test doubles identify the extraction call by the literal string `"Today's date"` at the start of its
system message. That string stays first precisely so this discrimination keeps working, which makes
an implementation detail of the test suite into a constraint on the prompt's opening. It is recorded
here so a future rewrite knows the constraint is real rather than stylistic.
