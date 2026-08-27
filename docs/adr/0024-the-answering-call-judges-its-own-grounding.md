# 0024: The answering call judges its own Grounding

## Status

Accepted. Extends [0023](0023-reflection-is-a-fixed-three-source-fan-out.md) — the fan-out, the
merge rule, the extraction call, and (at the time this ADR was written) `MIN_SIMILARITY` as a cheap
noise filter all stood exactly as that ADR left them. What this ADR changes is the one line 0023
flagged as provisional: `grounded` used to mean "the merged retrieval set is non-empty"; 0023's own
"Why no floor was chosen instead" section measured that this had stopped meaning anything on a
realistic History and said the judgment would move off cosine "in ticket 6." This is that ticket.
0023's own text has been cross-linked back to this ADR at the two places it made that promise.

**`MIN_SIMILARITY` no longer stands as this ADR left it.** Issue #92 deleted it outright — see
[0023](0023-reflection-is-a-fixed-three-source-fan-out.md)'s Status for the measured reason (issue
#90: mean recall 0.319 with 7 of 22 Questions at exactly zero, and the score tracking phrasing, not
topic). The "A recalibrated `MIN_SIMILARITY`" alternative below, and its closing line that
`MIN_SIMILARITY` "stays exactly where 0023 left it," describe a state that no longer holds; kept
below for the historical record of why recalibration specifically was rejected, which is still the
correct reasoning — it is why issue #92 removed the floor rather than retuning it.

## Context

CONTEXT.md's Grounding entry states the rule Reflection exists to honour: *"An Answer with no
Grounding behind it says so plainly rather than filling the gap from somewhere else — a Reflection
that invents a past the user did not live [is worse]."* Before this ticket, nothing in
`/v1/reflect` actually enforced that rule. `grounded` was computed as `!merged.is_empty()` — true
whenever the three-source fan-out returned at least one row — and 0023 measured, against the live
572-Entry corpus, that this is true for essentially every Question a real History receives: an
*absent* topic ("Have I written anything about my cat?", nothing about a cat in the History) tops
out at cosine 0.691, while a *present* one with five real Entries behind it ("Tell me about the
wedding") tops out at 0.638. The two ranges overlap, and on a large enough corpus a nearest-
neighbour search almost always finds *something* within `MIN_SIMILARITY` of any query — not
because that something is relevant, but because 572 ordinary-prose Entries span enough of
Harrier's embedding space that a few of them land near any query by coincidence. `grounded` was
therefore not a relevance signal at all; it was closer to a constant.

The fix has to happen somewhere that actually reads what retrieval found. Cosine similarity is
computed *before* the chat call ever sees the Question and the Grounding side by side; the chat
call is the only place in the request that has both. 0023 already observed this working
incidentally: asked "Have I written anything about scuba diving in Portugal?" with two unrelated
Entries as Grounding, the model answered "I found nothing in these entries about scuba diving or
Portugal" — the right answer, reached despite the floor having nothing useful to say. This ADR
makes that judgment load-bearing instead of a happy accident, and verified it directly against the
real configured endpoint before this ticket was written: a knee Question with real knee Entries
came back `GROUNDED: yes`; the scuba-diving Question above, with two unrelated Entries as
Grounding, came back `GROUNDED: no`.

## Decision

**The relevance verdict is folded into the existing answering call (chat call 2), not spent on a
third call and not read from cosine.** `SYSTEM_INSTRUCTION` now instructs the model that its reply
must *begin*, on its own line, with exactly `GROUNDED: yes` or `GROUNDED: no` — `yes` only if the
Grounding it was given actually contains enough to answer the Question, `no` if it does not, and
the prompt says explicitly that an Entry which merely shares a mood or a turn of phrase with the
Question is not an answer to it. The endpoint every `LlmClient` call goes through accepts only
`model`, `messages`, `stream` (0021) — no `response_format`, no tools, every model behind it
reports `"tools": false` — so, exactly as 0023 already established for the extraction call, this
is prompt-and-parse, not structured output.

**`parse_and_strip_verdict` (`server/src/reflect.rs`) reads the marker back out defensively, and
strips it before the Answer goes anywhere else.** It matches the first non-empty line of the raw
response, tolerating markdown noise (`*`, `_`, backticks, `#`) and surrounding whitespace,
case-insensitively — a model asked for a bare `GROUNDED: no` will sometimes hand back
`**GROUNDED: NO**` or `` `Grounded: No` ``, and the marker still has to be recognised. The marker
line is then removed from the Answer entirely: the Answer the client stores becomes a `prior_turn`
on the next Question (`ReflectRequest::prior_turns`), so a leaked marker would round-trip back into
a future prompt and poison the Conversation with a line that was never meant to be read as prose.

**A missing or unrecognised marker defaults to `grounded: !merged.is_empty()`, logged at `warn`,
and otherwise changes nothing.** (A code-review fix on `f97d697..HEAD` corrected this from an
unconditional `grounded: true`, which turned out to make `grounded: true` with an empty
`grounding_entry_ids` reachable — see the next paragraph.) This is the same posture 0023 already
took for extraction failure: a feature that exists to make an *honest* judgment must never be able
to accidentally fail *closed*. The opposite default — treating "no marker found" as "not grounded"
unconditionally — would fire the fallback below, and its extra chat call, on every response that
simply forgot the line, which is a real cost (another ~7s round trip) for a failure mode that has
nothing to do with whether the Grounding was actually relevant. Keying the default on whether the
merged set is empty keeps that fail-open intent exactly where retrieval found something — a
forgotten marker over real Grounding still degrades to what 0023 left behind: an Answer straight
from this call, no fallback, `grounded: true` — while a forgotten marker over nothing now falls
into the disclosed fallback below, which is the correct outcome when retrieval genuinely found
nothing, not a wasted call.

**`grounded: true` must never be reachable with an empty `grounding_entry_ids`.** Before the
code-review fix above, a merged set that was empty *and* a missing/garbled marker combined to
produce exactly that: `grounded: true, grounding_entry_ids: [], fallback_used: false`. Nothing but
the model's own prose then said anything was missing — ticket 6's client (no note) and ticket 7's
disclosure (`null` on empty ids) both stay silent in that state, which is the exact dependence on
the model's own wording ticket 6 exists to remove, and a direct violation of CONTEXT.md's rule that
an Answer with no Grounding behind it says so plainly. Defaulting the `None` case to
`!merged.is_empty()` makes that combination unrepresentable: `grounded: true` now implies a
non-empty merged set by construction, whether the verdict came from a marker or from this default.

**A `GROUNDED: no` verdict triggers a disclosed fallback — never a fourth retrieval source, and
never merged into Grounding.** It runs only after the verdict, is never part of the normal
three-source fan-out, and its own Entries are never treated as relevant matches:

1. Retrieve the Entries from a **rolling** `Utc::now() - FALLBACK_WINDOW_DAYS .. Utc::now()`
   window (3 days) through the existing `retrieve_range` — the same retriever 0023 built for the
   extracted date range, reused rather than duplicated. This is deliberately a rolling window, not
   the local-calendar-day machinery `local_date_range_to_utc` gives the *extracted* range: the
   fallback answers "what have you written *lately*", not a date the user named, so there is no
   local day to align to, and recency relative to right now is exactly what's wanted regardless of
   `utc_offset_minutes`.
2. If that window has Entries, a **second** answering call runs, with a different system prompt
   (`FALLBACK_SYSTEM_INSTRUCTION`) instructing the model to open by saying plainly that nothing
   matching the Question was found, then briefly describe what the user has been writing about,
   using only those Entries. This call carries no verdict marker at all — its verdict is already
   known (`grounded: false`) — so `run_reflect` never runs its response through
   `parse_and_strip_verdict`. `fallback_used: true`, `grounded: false`, and `grounding_entry_ids`
   become those Entries' ids.
3. If the window is empty, there is nothing to disclose either: no third chat call is spent on an
   empty result, `fallback_used: false`, `grounding_entry_ids: []`, and the Answer already
   returned by the first call (the model's own "I found nothing") is kept as-is.

**`ReflectResponse` gains `fallback_used: bool`, and `grounded`'s meaning changes.** `grounded` now
means "Reflection judged that the Grounding it found actually answers the Question" — read from
the verdict marker, not from whether retrieval returned rows. Its doc comment states both what it
means now and what it meant through ticket 5, citing the 0023 measurements above, so a reader who
only has the current code can still see why the field changed shape rather than just what it
means today. `grounding_entry_ids`'s doc comment is equally explicit about the two cases it can now
carry: in the normal case these are Grounding, judged relevant; in the fallback case
(`fallback_used: true`) these are instead the last few days of Entries, shown *despite* not
answering the Question. `grounded: false` is what tells a reader — ticket 7's disclosure UI
included — which case it is; the field's own emptiness or non-emptiness cannot tell them apart,
since both cases can be non-empty.

**`PROTOCOL_VERSION` stays 1.** `fallback_used` is an additive response field; an existing client
that predates this ticket simply ignores it, the same reasoning 0023 already used for
`utc_offset_minutes` on the request side.

Wire types are regenerated from the server (`pnpm --filter @meologue/core generate:wire-types`),
never hand-edited (ADR 0004).

## Alternatives considered

- **A separate, dedicated judge LLM call.** Rejected on cost: the endpoint this project calls
  costs roughly 7 seconds per call, and Reflection is already two calls deep after 0023 (extraction,
  then the answering call). A third call spent purely on a yes/no verdict would add another ~7s to
  *every* Question, not just the ones that turn out to need the fallback — the marker folded into
  the existing answering call gets the same judgment for free, and the fallback's own extra call
  is spent only on the Questions that actually need it.
- **A recalibrated `MIN_SIMILARITY`.** Rejected for the reason 0023 already measured and this ADR
  restates: the present-topic and absent-topic cosine ranges overlap on a realistic corpus ("my
  cat," absent, tops out higher than "the wedding," present with five real Entries), so no single
  threshold separates them — and the number drifts as the History grows, so any value chosen today
  is a moving target with no stable value to retune toward. `MIN_SIMILARITY` stays exactly where
  0023 left it: a cheap noise filter that keeps an obviously unrelated Entry from ever reaching the
  prompt, never the mechanism that decides relevance.
- **Fire the fallback only when the merged fan-out set is empty**, which is what the plan this
  project is built from originally specified. Rejected once measured: on the live 572-Entry corpus,
  the merged three-source set is essentially never empty — the same corpus-scale effect that broke
  `grounded` as a signal (0023's "the floor does not survive a realistic corpus") means retrieval
  almost always returns *something*, even for a genuinely absent topic. Triggering the fallback on
  emptiness would have made `fallback_used` dead code in practice: exactly the finding that forced
  this ticket to key the fallback off the chat call's own verdict instead of off retrieval being
  empty. This is the one place this ADR overrides what was originally planned rather than
  elaborating on it, and it's recorded here because the discovery — not the mechanism — is what
  actually redesigned the ticket.
- **A structured verdict field (`response_format` or a tool call), instead of a marker line in
  plain text.** Rejected as unavailable, for the same reason 0023 rejected it for extraction: the
  endpoint accepts only `model`, `messages`, `stream`, and every model behind it reports
  `"tools": false`. Prompt-and-parse is the only mode this endpoint supports.

## Consequences

The relevance judgment is now the model's, not a formula's, and there is no independent check on
it. A model that judges its own Grounding badly — too eager to call `GROUNDED: yes` on a thin
match, or too quick to call `GROUNDED: no` on a real one — produces a wrong `grounded` with nothing
in this design to catch it. This is an accepted cost: the alternative (cosine) was measured, not
assumed, to be worse on a realistic corpus, and CONTEXT.md's rule cannot be enforced by a floor
that cannot tell "relevant" from "large enough History that something is always nearby."

Latency grows only on the Questions that need it: a `GROUNDED: yes` verdict costs nothing beyond
what 0023 already spent (two calls), while a `GROUNDED: no` verdict with recent Entries costs a
third ~7s call. A `GROUNDED: no` verdict with nothing recent costs nothing extra — the empty-window
case is checked before any further chat call is made.

`grounding_entry_ids` can no longer be read as "the Entries that were relevant" without also
reading `grounded`. Ticket 7's disclosure UI is built on that pairing directly, and any future
reader of this field has to keep both in view: non-empty and `grounded: true` means real Grounding;
non-empty and `grounded: false` means the disclosed fallback; empty means nothing was found or
shown either way.
