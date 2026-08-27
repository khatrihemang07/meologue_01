# 0023: Reflection is a fixed three-source fan-out

## Status

**Superseded by [0031](0031-reflection-is-a-loop-over-tools.md): the fixed pipeline this ADR
describes — one extraction call, three concurrent retrievals, merge/dedupe/cap at 40, one
answering call — no longer exists in the code.** Issue #99 (`6bed6b5`) removed it outright,
replacing it with the agent loop 0031 records: the model asks for a tool, reads the result, and
asks again until satisfied, rather than being handed one fixed, pre-computed retrieval set. This
ADR's own "Why no floor was chosen instead" section and its `MIN_SIMILARITY` deletion (issue #92)
are unaffected by the supersession — that reasoning stood on its own and is not undone by the
pipeline it lived inside going away. Nor is this ADR's "client injects its own UTC offset, the
Server never guesses the timezone" rule: `ReflectRequest::utc_offset_minutes` and
`local_date_range_to_utc` both survive unchanged, now read by the loop's `entries_in_range` tool
([0031](0031-reflection-is-a-loop-over-tools.md)) and by the system prompt's own injected local
date, rather than by the extraction call this ADR built them for. Kept in full below as the record
of a design that was tried, measured, and found wanting on evidence — not merely replaced by
preference. Everything below this line describing the extraction call, the fan-out, and the merge
rule describes code that no longer exists; the timezone-handling rule is the one piece of this
ADR's Decision that outlived the pipeline it was written inside.

Accepted. Extends [0021](0021-the-server-calls-an-openai-compatible-llm.md) (the chat/embedding
egress this ticket's second chat call and two extra embedding calls spend) and
[0022](0022-entry-embeddings-are-filled-by-a-background-worker.md) (the vectors this ticket
searches against, and the `vector_literal` binding shape ticket 4's `retrieve_nearest` already
established and this ticket's `retrieve_range` reuses). Nothing here supersedes either — both
stand exactly as written; this ADR only records what got built on top of them.

Extended by [0024](0024-the-answering-call-judges-its-own-grounding.md): this ADR's own "Why no
floor was chosen instead" section below already anticipated that the relevance judgment would
move off cosine "in ticket 6" — 0024 is that ticket. The specific line below reading "`grounded`
is unchanged... that is the next ticket's job" is what 0024 changes; the fan-out, the merge rule,
the extraction call, and everything else in this ADR stand exactly as written.

Also extended by [0026](0026-the-extraction-call-sees-the-conversation.md): this ADR built chat
call 1 from the system prompt and the current Question alone, which lost nothing while a
Conversation died on reload and almost every Question was a first Question. Once
[0025](0025-sessions-are-held-by-the-server.md) made Sessions durable, a follow-up's referent
("that", "the week before") lived in the Conversation the extraction call could not see. 0026 gives
it the same bounded window the answering call gets. This ADR's floor — any extraction failure
degrades to "no range, no keyword", never to a failed Question — is explicitly unchanged, and so is
everything else here. (Note: "floor" in that sentence means the degrade-to-baseline guarantee for
extraction failure, unrelated to the `MIN_SIMILARITY` floor the amendment below removes — the two
uses of "floor" in this ADR's history mean different things and neither reader should assume the
other changed.)

**Amended by issue #92: `MIN_SIMILARITY` is deleted outright, not merely "kept as a cheap noise
filter."** The "Why no floor was chosen instead" section below already argued the number could
never be tuned to a correct value; issue #90's eval harness
(`server/tests/eval-retrieval-baseline.md`) then measured what that indecision cost in practice —
mean recall **0.319** across 22 Questions with the floor applied, **7 of them scoring exactly
zero** — and found the mechanism itself is the problem, not the constant: **the score tracks
phrasing, not topic.** "Did I mention a trip to Japan anywhere?" cleared 0.60 five times over for a
topic entirely absent from the journal, while "what did I write about Priya's wedding" topped out
at 0.363 and returned nothing for a topic that is present. No threshold value can fix that, because
the quantity being thresholded does not mean the same thing from one Question to the next — the
same finding this ADR's own "absolute cosine is not comparable" section already named, taken to
its conclusion. `retrieve_nearest` now returns its top-k unconditionally; the answering call's own
judgment ([0024](0024-the-answering-call-judges-its-own-grounding.md), already this codebase's real
relevance mechanism since that ticket) is what decides relevance, with nothing underneath it. The
"MIN_SIMILARITY stays at 0.60" decision and the "Why no floor was chosen instead" section below are
superseded by this — kept in place, not deleted, as the record of why a floor was tried before this
ADR's own measurements caught up with its reasoning.

## Context

Ticket 4 gave `/v1/reflect` one retrieval: embed the Question, run `retrieve_nearest` against
`MIN_SIMILARITY`, hand whatever cleared the floor to a chat call. That is exactly right when the
Question's own wording is close to how the relevant Entries were written, and exactly wrong when
it isn't — a Question that names a topic obliquely ("how did the move go") or refers to a span of
time ("what did I write last week") has no reason to sit near the right Entries in embedding
space, even though a human reading the same Question would know precisely what to look for.

Two gaps, not one, motivated widening retrieval. The first is measured directly: re-running the
corpus check `reflect.rs`'s `MIN_SIMILARITY` doc comment already cited, now against 572 Entries,
"Tell me about the wedding" clears the floor with exactly **one** Entry — the four other real
wedding Entries sit at 0.586, 0.576, 0.573, and 0.573, all just under 0.60. A single vector search
cannot rescue those four without lowering the floor for every Question, which would let in exactly
the unrelated Entries the floor exists to keep out (see the measurement below). The second gap is
structural: nothing about a single vector search can ever answer "what did I write yesterday" or
"last week" correctly, because a date is not a semantic property an embedding captures — the
Question's vector and an Entry's vector can be arbitrarily far apart while the Entry is still the
exact, only correct answer.

The settled design (see the plan this ticket implements) fixed the shape ahead of time: **two LLM
calls, three retrievals, no agentic tool-call loop.** That scope discipline is what this ADR
records and defends.

## Decision

**Chat call 1 extracts a date range and/or a keyword from the Question; three retrievals run
concurrently; chat call 2 turns the merged result into an Answer — nothing more.** *(Chat call 1
reads the recent Conversation as well as the Question as of
[0026](0026-the-extraction-call-sees-the-conversation.md); the shape below is otherwise
unchanged.)* No tool-call loop, no model deciding at runtime which retriever to invoke or how many
times. The two retriever
functions (`retrieve_nearest`, `retrieve_range`) are deliberately narrow and few — the plan calls
them "the future tool definitions" on purpose: if an agentic loop is ever justified, it is built
*behind* these same two functions rather than requiring a redesign of what "search" or "range"
means. Reflection does not need that flexibility yet, and building it before something needs it
would be exactly the kind of scope creep this project's ADRs (0014, 0022) have consistently
rejected for "scale nobody has yet."

**Extraction is prompt-and-parse, not structured output.** The endpoint every `LlmClient` call
goes through (`OpenAiCompatibleClient`, ADR 0021) accepts only `model`, `messages`, `stream` — no
`response_format`, no tools; every model behind it reports `"tools": false`. `reflect.rs`'s
`extraction_system_prompt` asks in plain English for "a single JSON object and nothing else, no
prose, no markdown code fence," and `parse_extraction` reads whatever comes back defensively:
strip a markdown fence if present, take the substring from the first `{` to the last `}`, parse
that as JSON into a loosely-typed `serde_json::Value` rather than a strict struct, and read
`date_range`/`keyword` out field-by-field so a missing field, a `null`, or a field of the wrong
type degrades only that one field — not the whole response. A model that reversed `from` and `to`
almost certainly reversed the dates themselves too, so a nonsensical range (`to < from`) is
dropped rather than swapped, without discarding a `keyword` extracted alongside it.

**Any failure in extraction degrades to "no date range, no keyword," never to a failed Question.**
The chat call erroring, timing out, or returning something that doesn't parse as JSON at all all
land in the same place: `Extraction::default()`, logged at `warn` with the reason, and the
fan-out then behaves exactly like ticket 4 — question-only retrieval. A feature meant to widen
recall must never be able to narrow it to zero; the floor is "at least what ticket 4 already
gave," never less.

**The client injects its own UTC offset; the server never guesses the timezone.** `ReflectRequest`
gains `utc_offset_minutes: i32`, the same sign convention (minutes east of UTC) ADR 0016 already
settled for Export's per-day grouping — `apps/web/src/lib/entry-day.ts`'s `deviceUtcOffsetMinutes`
is the same function both features call. The extraction prompt states today's date computed from
that offset, never from the server's own clock, so "yesterday" or "last week" resolves against the
Device's local day — exactly the reasoning ADR 0016 gives for why Export groups by the exporting
Device's local day rather than the UTC calendar date. `#[serde(default)]` rather than a required
field: `PROTOCOL_VERSION` stays **1**, because this is an unrelated feature riding the same sync
contract, and a Device that predates this ticket must not be told the Server is unreachable over a
field it has never heard of. A request with no `utc_offset_minutes` at all defaults to `0` and
still gets an Answer — a graceful degrade to UTC-relative dates, not a rejected Question, mirroring
the same "never fail the Question" posture extraction failure gets. The received value is clamped
to `[-840, 840]` minutes (±14h, the real-world extreme) before anything uses it, so a malformed or
hostile value cannot push the date arithmetic somewhere absurd.

Converting an extracted local `[from, to]` date range into the UTC instants `retrieve_range` needs
is a half-open interval: `from` local midnight minus the offset is `from_utc`; `to`'s local *next*
day midnight minus the offset is `to_utc`. `[from_utc, to_utc)` is what makes a single-day range
(`from == to`) cover the Device's whole local day rather than a single instant — this is tested
explicitly at the boundary, including the case (offset +330, IST) where an Entry's UTC timestamp
sits on the previous UTC calendar day but the correct local day.

**The merge rule: concatenate in source priority order, dedupe by id keeping the first occurrence,
cap at 40, *then* sort chronologically.** The three retrievals — `retrieve_nearest(question)`,
`retrieve_nearest(keyword)`, `retrieve_range(from, to)` — are concatenated in that fixed order,
never any other: question-search results first (similarity descending, as `retrieve_nearest`
already orders its rows), then keyword-search results (also similarity descending), then range
results last (recency descending, as `retrieve_range` already orders its rows). A `HashSet<Uuid>`
dedupes by keeping whichever occurrence came first in that order, and the merged list is then
truncated to `RETRIEVAL_LIMIT` (40) *before* being re-sorted into chronological order for the
prompt. Priority order is load-bearing, not incidental: the Question's own vector is the single
most trustworthy signal Reflection has, and a wide extracted range ("this year") can return the
full 40-row quota from `retrieve_range` alone — putting range last in the concatenation is what
stops a broad date range from crowding out the very Entries the Question's own search asked for.
Sorting only after truncation, not before, is the same reasoning from the other direction: the
priority order decides *which* Entries survive the cap; chronological order only decides how the
survivors are *read*.

**`retrieve_range` carries no `embedding is not null` guard, unlike `retrieve_nearest`.** That
guard exists on `retrieve_nearest` because `<=>` cannot be evaluated against a null vector — it is
a mechanical necessity of the comparison, not a judgment that an unembedded Entry is untrustworthy.
A date range is an exact fact about an Entry (`created_at` is set once, at insert time, and never
changes), not a similarity guess, so an Entry the background embedding worker (ADR 0022) hasn't
reached yet is still a perfectly good answer to "what did I write yesterday." Excluding it would
silently drop a true answer for a reason that has nothing to do with what was actually asked.

**`grounded` is unchanged: "the merged set is non-empty."** No `fallback_used`, no disclosed
3-day fallback when nothing is found — that is the next ticket's job, deliberately not pulled
forward here. Building it now would be answering a question ("what does Reflection say when it
finds truly nothing?") this ticket was never scoped to answer, ahead of the ticket that actually
needs it. (Superseded by [0024](0024-the-answering-call-judges-its-own-grounding.md): `grounded`
now means something else, and the disclosed fallback described as "the next ticket's job" here is
what that ADR builds.)

### The floor does not survive a realistic corpus

`MIN_SIMILARITY = 0.60` was measured against roughly 80 Entries, and against that corpus the claim
below was true: a Question about something never written down cleared the floor with nothing, and a
Question with a real thread behind it cleared it comfortably. **Re-measured against the 572-Entry
corpus now in Postgres, that ordering does not hold — an *absent* topic can outscore a *present*
one:**

| Question | top cosine | Entries ≥0.60 |
|---|---|---|
| "Have I written anything about my cat?" (nothing in History about a cat) | 0.691 | 4 |
| "Have I written anything about scuba diving in Portugal?" (absent) | 0.631 | 2 |
| "Tell me about the wedding" (five real wedding Entries exist) | 0.638 | 1 |

572 ordinary-prose Entries are enough that, in Harrier's embedding space, almost any Question sits
within 0.60 of *something* — not because that something is relevant, but because a History this
size spans enough of the space that a few Entries land near any query by coincidence. `grounded` —
"the merged set is non-empty" — is therefore true for essentially every Question a real History
receives today. **CONTEXT.md's rule that "an Answer with no Grounding behind it says so plainly" is
not enforced by the floor** — when it holds, it is because the chat call itself, reading the
Grounding it was actually given, is honest about what does and doesn't support an Answer (see "What
did verifiably improve" below), not because "no Grounding" is a state the floor can still reach.

### Why no floor was chosen instead

*(This section's own reasoning is what issue #92 eventually acted on fully — see this ADR's Status.
It is kept exactly as written below because every word of it turned out to be correct; what changed
is the conclusion drawn from it, not the argument.)*

The present-topic and absent-topic ranges above overlap — "my cat" (absent) tops out higher than
"Tell me about the wedding" (present, five real Entries) — so no single threshold separates them on
this corpus. And the number drifts as more Entries are written, so any value chosen today expires:
retuning it against a corpus that keeps growing is not a one-time measurement, it is unbounded
maintenance with no stable target to aim at.

`MIN_SIMILARITY` stays at 0.60, but only as a cheap noise filter — it still keeps an obviously
unrelated Entry from ever reaching the prompt — never as the mechanism that decides whether a
Question is grounded. *(Deleted outright by issue #92, not merely demoted further — see this ADR's
Status. Issue #90's eval harness measured that this "cheap noise filter" framing was itself too
generous: the filter doesn't separate noise from signal, it separates phrasing from phrasing, so
keeping it around "just in case" was still doing nothing but discarding correct Entries before the
chat call could see them.)* That judgment is moving off cosine entirely in ticket 6. The chat call
already sees the Grounding it's handed and already reports correctly when the Grounding doesn't
answer the Question: observed live, asking "Have I written anything about scuba diving in
Portugal?" while holding two unrelated Entries as Grounding, the model answered "I found nothing in
these entries about scuba diving or Portugal" — the right Answer, reached despite the floor having
nothing useful to say about relevance. Ticket 6 is what makes that judgment the system's actual
relevance mechanism, instead of an incidental side effect of a well-behaved chat model.

### Absolute cosine is not comparable

Worth restating plainly, because a table of numbers next to each other invites forgetting it:
**cosine similarity is not comparable across queries, across phrasings, or across corpus sizes.**
Nothing in this codebase may assume a global scale, or that a given value means the same thing for
two different Questions. The keyword-wrapping change below is a direct instance of this, not a
separate concern — rephrasing the *same* topic from a bare word into a question moved every
similarity in the corpus, without the corpus or the topic changing at all.

**Harrier pools the last token, so trailing punctuation dominates the embedding vector.**
`end_with_sentence_punctuation()` in `llm.rs` exists for exactly this reason and must stay: a
Question that stops mid-phrase is out of distribution against the Entries it's compared to, all of
which are ordinary prose ending in `.`, `?`, or `!`. Measured on this corpus, "What did I write
about the wedding" (no trailing punctuation) retrieved unrelated Entries at 0.357, while the same
text with a "?" appended retrieved the real wedding Entries at 0.677 — a difference large enough to
single-handedly decide whether `MIN_SIMILARITY` is cleared at all.

### The keyword is embedded wrapped as a question

`run_reflect`'s keyword search now embeds the extracted keyword wrapped in a question —
`"What did I write about {keyword}?"` — rather than the bare word, via a small `keyword_query`
helper in `reflect.rs`. `llm.rs` is untouched: `embed_query` still adds Harrier's `Instruct:`
wrapper on top of whatever string it is given, and that layering is correct; `keyword_query` only
decides what string reaches it. Harrier pools the last token (above), so a bare topic word is out
of distribution against Entries that are ordinary prose — wrapping it as a question puts it back in
distribution, the same reasoning `end_with_sentence_punctuation` already applies to the Question
itself. Measured on the 572-Entry corpus, top cosine and count of Entries clearing
`MIN_SIMILARITY`, bare keyword vs. the same keyword wrapped as a question:

| keyword | bare: top / ≥0.60 | wrapped: top / ≥0.60 |
|---|---|---|
| wedding | 0.507 / 0 | 0.684 / 5 |
| guitar | 0.558 / 0 | 0.645 / 3 |
| marathon training | 0.662 / 3 | 0.706 / 7 |
| knee | 0.670 / 4 | 0.750 / 6 |
| Aurora migration | 0.697 / 5 | 0.752 / 6 |

Five real wedding Entries exist in the corpus; the bare keyword found none of them — this is the
recall gap this ADR exists to close, and wrapping closes it. The cost is taken openly, not
overlooked: wrapping raises similarity across the board, not just for topics that are actually
present, so it also lifts unrelated Entries above the floor — an absent topic, "my cat", goes from 0
Entries over the floor to 7. It buys recall at the cost of precision. That trade is acceptable
specifically because the floor is no longer where correctness lives ("why no floor was chosen
instead," above) — the relevance judgment ticket 6 moves onto the chat call is what has to hold the
line 0.60 used to be asked to hold.

### What did verifiably improve

Despite the floor's unreliability, one piece of this ticket is unambiguously working end to end: the
date-range retriever. "What did I write yesterday?", asked with `utc_offset_minutes: 330`, resolved
to the correct local day — not the server's UTC day — and returned the right Entry, answered
correctly, against the live corpus. Unlike the question and keyword searches, `retrieve_range` never
depended on cosine at all, which is exactly why it kept working unchanged while the corpus grew from
~80 Entries to 572: a date range is an exact fact about an Entry, not a similarity guess, and
nothing measured above touches that.

### The recall gap this ticket exists to close

The wedding measurement above ("Tell me about the wedding" clearing the floor with one Entry out
of five real ones) is the concrete case this three-source fan-out was designed against: a wide or
oblique Question whose own vector search finds only the most on-the-nose Entry, leaving the rest
just under the floor. The extraction call's job is to notice, from context, that "the wedding" is
also a keyword worth a second, independently-embedded search — which does not share the first
search's exact phrasing bias — and possibly a date range, if the Question names or implies one. The
keyword-wrapping change above is what closed it for "wedding" specifically: 5 of 5 real Entries now
clear 0.60, up from 1 of 5 before this ADR's correction. But the corpus-scale measurement earlier in
this section is the more important finding: the floor was never a durable fix for this class of
problem, because it cannot tell "found something relevant" apart from "found something, because the
corpus is large enough that something is always within reach." Ticket 6 — the relevance judgment
moving onto the chat call — is where that distinction has to be made, not a fourth retrieval source
or a re-tuned constant.

## Alternatives considered

- **An agentic loop where the chat model decides at runtime which retriever(s) to call, and how
  many times.** Rejected for this ticket on the plan's own scope line: "a fixed pipeline, not an
  agentic harness." A loop adds real complexity (multiple round-trips, a stopping condition, more
  surface for a misbehaving model to spin) for a gain this ticket's fixed three-source fan-out
  already delivers for the cases actually observed. The two retriever functions are shaped
  narrowly enough that a loop, if one is ever justified, can be built on top of them later without
  redesigning what a "search" or "range" tool call means.
- **Structured-output (`response_format: json_schema`) or a tool-call for the extraction step.**
  Rejected as unavailable: the configured chat endpoint accepts only `model`, `messages`, `stream`,
  and every model behind it reports `"tools": false`. Prompt-and-parse is not a stylistic choice
  here — it is the only mode the endpoint supports, which is why `parse_extraction` treats a
  malformed response as an expected, defensively-handled outcome rather than a bug.
  `llm.rs` gains no `response_format` field over this ticket.
- **Let the server derive "today" from its own clock.** Rejected on ADR 0016's own precedent: a
  server or Device's own timezone is not the user's, and guessing it would silently misresolve
  "yesterday" for anyone not in the server's timezone — the exact class of bug ADR 0016 documents
  Export avoiding by taking an injected offset rather than asking the host what timezone it thinks
  it's in.
- **Bump `PROTOCOL_VERSION` to make `utc_offset_minutes` required.** Rejected: the sync contract's
  shape is unchanged, and Reflection is a separate concern from what `PROTOCOL_VERSION` gates
  (whether a Device and Server can exchange Entries at all). Bumping it over an unrelated field
  would make every existing Device — including ones that will never use Reflection — report the
  Server as unreachable.
- **Sort the merged candidates chronologically before truncating, rather than after.** Rejected:
  that would let range results (potentially the largest single source, on a wide range) push the
  Question's own top matches out of the cap by virtue of being older or newer, defeating the whole
  point of prioritising question-search. Truncation has to happen while priority order is still
  the ordering in effect.
- **Give `retrieve_range` the same `embedding is not null` guard as `retrieve_nearest`, for
  consistency.** Rejected: the guard is not a style choice being applied inconsistently, it is a
  mechanical requirement of `<=>` that simply does not apply to a `created_at` comparison. Adding
  it to `retrieve_range` would silently exclude Entries the background worker hasn't embedded yet
  from a query that never needed an embedding to answer correctly in the first place.

## Consequences

Every Question now costs two chat calls and up to three embedding calls instead of one and one —
real latency, spent deliberately on the recall gap measured above. The wedding-style recall case
did visibly improve once the keyword-wrapping change shipped (5 of 5 real Entries now clear 0.60,
up from 1 of 5). But the corpus-scale measurement in "the floor does not survive a realistic
corpus" showed `MIN_SIMILARITY` is not the durable fix this ADR originally treated it as — an
absent topic can outscore a present one on the 572-Entry corpus, so `grounded` is no longer a
meaningful signal on its own. The follow-up is ticket 6's relevance judgment, not a fourth
retrieval source or a further re-tuned constant, which would be the same kind of scope creep this
ADR's "no agentic loop" decision exists to resist.

Extraction failures are silent by design (a `warn` log, not a metric or an alert) — a sustained
pattern of extraction failures (a chat endpoint that reliably 4xxs, or a model that never produces
parseable JSON) degrades Reflection to ticket 4's behaviour without ever surfacing as a visible
problem to an operator. That is an accepted gap for this ticket, in the same spirit ADR 0022 left
`MAX_ATTEMPTS`-exhausted Entries unalerted: a real observability pass, if one is ever justified, is
a later ticket's to build, not a reason to hold this one.

`RETRIEVAL_LIMIT` (40) now caps two different things — each individual retrieval's own SQL
`LIMIT`, and the merged, deduped set handed to the prompt. A future ticket that wants to tune those
independently (a wider net per retriever, a smaller final cap for prompt-size reasons, or vice
versa) will need to split the one constant into two; nothing here forces them to move together
forever, it is simply what one number happens to do for both jobs today.
