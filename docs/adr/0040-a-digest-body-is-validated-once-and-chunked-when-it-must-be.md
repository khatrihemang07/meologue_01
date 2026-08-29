# 0040: A Digest body is validated once, and chunked when it must be

## Status

Accepted. Extends [0027](0027-digests-are-written-ahead-of-time-by-a-background-worker.md) (the
worker, its resume rule, and its budgets) and
[0039](0039-digests-gain-revisions-and-can-be-asked-for.md) (revisions, the staleness watermark,
and the regenerate route). It supersedes nothing in either — every rule both ADRs already record
(the resume rule, "the worker generates, it never regenerates," reads take the newest revision
unconditionally) stands exactly as written. This ADR only records what got built on top: a single
validated path from a Period's Entries to a stored body, used by both writers, that can also split
an oversized Period across several chat calls and survive one of those calls failing.

## Context

Two problems surfaced once someone actually looked at what the two Digest writers — the background
worker's `write_digest_for` and the regenerate route's `run_regenerate` — did with a chat reply
before storing it.

**Neither writer validated the model's reply.** Only a transport `Err` from the chat call counted
as failure. A 200 OK carrying an empty string became the Digest body outright, because `digests`'
`body text not null` accepts `""` without complaint — it is not null. On the worker side this was
merely wasteful: `write_digest_for` cleared its own attempt counter the moment the insert
succeeded, since as far as it knew nothing had gone wrong. On the regenerate route it was worse.
`select_digest_at` and `select_latest_digest` both read `order by revision desc` unconditionally
(ADR 0039) — there is no revision picker anywhere, only ever "the newest." So a blank revision N+1
didn't just fail to improve on revision N; it **shadowed** a perfectly good one still sitting one
revision back. Pressing Regenerate on a Digest that was merely stale could blank it. Reflection had
already solved the identical problem: `reflect::is_empty_final_reply` recognises empty,
whitespace-only, and fence-only replies, and `NonEmptyAnswer` is a newtype whose only constructor
rejects them, so nothing downstream can read an unchecked Answer. Digest had no equivalent of
either.

**Digest had no context-window awareness at all.** It discarded the `usage` the chat endpoint
reports and did no size check before sending — a whole Period's Entries went into one user message
raw, regardless of how large the Period was. Reflection, by contrast, passes a resolved context
window into every loop call. Nothing about Digest's one call had ever been sized against the window
it was actually running inside.

**The measurement that justifies the shape below**: against the Sandbox corpus of 121 Entries over
68 days, the heaviest month is 56 Entries / 10,302 characters — roughly 2,576 tokens, about **8%**
of a 32,000-token window. The chat model actually configured, `codex-terra`, reports a real
**272,000**-token context window, of which 60% is ~163,200 tokens ≈ 653,000 characters. A month
would need on the order of 690 Entries to overflow that budget. So the split this ADR records is,
today, **unreachable in production** — and that is exactly why the budget the worker chunks against
has to be an injectable parameter rather than a fixed constant: it is the same testability seam
`scan_interval` already is on `digest::run`, letting a test exercise the split at any corpus size
instead of waiting for a journal nobody has.

## Decision

**One shared step, `generate_digest_body`, is the only path from a Period's Entries to a body
either writer can store.** Both `write_digest_for` and `run_regenerate` call it; neither builds its
own messages, makes its own chat call, or trusts whatever comes back independently. This is
deliberate, not incidental: it is exactly how the regenerate route shipped unvalidated in the first
place — two call sites making the same decision twice, once correctly and once not. A third writer
added later goes through this same function or it does not get to write a Digest body at all.

**Validation reuses Reflection's own fence-stripping, not a second copy of it.**
`is_empty_digest_body` strips a wrapping code fence via `reflect::strip_code_fences` (already
`pub(crate)`) and checks what's left is nothing but whitespace — covering both shapes this was
filed against: a genuinely empty or whitespace-only reply, and a reply that ignores
`digest_system_prompt`'s explicit "no backticks" instruction and fences its prose instead.
`ValidatedDigestBody` is Digest's own `NonEmptyAnswer`: a newtype whose only constructor,
`ValidatedDigestBody::new`, rejects anything `is_empty_digest_body` flags, so `generate_digest_body`
is the only function in the crate that can turn a raw chat reply into something either writer is
allowed to store. Unlike `NonEmptyAnswer`, the accepted body is kept verbatim rather than trimmed —
a Period that succeeds must remain byte-identical to what this worker wrote before any of this
existed, and trimming incidental whitespace would be a behaviour change with no mandate behind it.

**`DIGEST_ENTRY_BUDGET_FRACTION = 0.60`, and why `harness::compaction::RESERVE_TOKENS` (16,384) is
deliberately not reused for it.** That reserve is sized for a *growing multi-turn transcript* — pi's
own reserve, kept empty so the reply following a compaction always has somewhere to write — the
opposite shape from a Digest's one call, which is a single system/user pair, made once, never
extended with more turns. Reusing it would also be actively worse than merely mismatched: against
the 32,000-token fallback window this worker inherits whenever a configured endpoint's own window
can't be learned, subtracting a flat 16,384-token reserve would leave only about 15,616 tokens —
under half the window — for Entries, on a call that never carries the multi-turn overhead that
reserve exists to protect. 0.60 is instead sized for what a Digest's one call actually needs room
for beyond the Entries themselves: a few hundred tokens of system prompt, a one-line wrapper
sentence, and the Digest's own prose reply, all of which fit comfortably inside the remaining 40%
even at the smallest realistic window.

**Entries are packed greedily, at Entry boundaries, by one code path for day, week, and month
alike.** `chunk_entries` walks Entries in their existing `created_at asc` order and closes the
current chunk the moment adding the next Entry would push it over `entry_budget_tokens`, never
splitting an Entry across two chunks. Nothing in the packing reads `Period` — only the Entries and
the budget — so a day, a week, and a month are chunked by the identical rule. **An Entry that alone
exceeds the budget still gets a chunk of its own**: the over-budget check only fires when the
current chunk already holds something, so a lone oversized Entry is accepted into an empty chunk
rather than dropped — there is no smaller unit to split it into, and dropping it would break the
completeness this worker has always guaranteed. The loop always terminates because every Entry is
consumed exactly once, whether or not it triggers a chunk boundary.

**A single-chunk Period is byte-identical to before; only a genuine split names a chunk's own
span.** `period_range_label` (the Period's own inclusive range) is used whenever `chunks.len() ==
1` — still, today, every real Period — and `chunk_range_label` (that one chunk's own
earliest-to-latest local date) is used only when a Period actually split. This is issue #101's
lesson one level up: that issue was filed because an Entry could be rendered under the wrong local
day inside a call that could see it fine; a multi-chunk call using the Period's own range would
repeat the identical failure one level up — a date label true of the whole Period but false of what
that one call was actually handed. "Here is everything the user wrote from X to Y" has to stay true
of what that call can actually see.

**Chunk bodies are concatenated with `"\n\n"`, never merged by a further call.** Handing a second
chat call the concatenation of several already-written summaries and asking it to summarise *that*
would be exactly the summary-of-summaries ADR 0027 already rejects for the cross-Period case (a
weekly Digest reading its daily Digests instead of the week's own Entries). Concatenation has no
second lossy pass, so nothing here needs one.

**A skipped chunk costs its own Entries, not the whole Digest.** A chunk's own failure — a
transport error, or a reply `ValidatedDigestBody::new` rejects — is caught inside
`generate_digest_body`'s loop rather than propagated with `?`, so one bad chunk never takes its
neighbours down with it. `grounding_entry_ids` already means "the Entries this Digest was actually
written from" (issue #70, long before chunking existed), so a skipped chunk's Entries simply do not
go in the array — no new column, no new wire field, the array discloses by doing its existing job on
a body that now covers less than the whole Period. Only when every chunk in a Period fails does
`generate_digest_body` return `Err`; a lone chunk failing *is* every chunk failing whenever
`chunks.len() == 1`, so the single-chunk path this function served before chunking existed is
unaffected.

**`source_seq = 0` for a partial Digest, and this is the deliberate inverse of the case migration
0009 avoided.** `0009_digests_gain_revisions.sql` refused to default every pre-existing row's
`source_seq` to `0` during its bulk backfill, in its own words, because "a marker that fires for
every Period at once tells a reader nothing" — every Digest already on disk would have reported
stale simultaneously, before a single Entry had actually changed, drowning any real signal in
uniform noise. This ADR's `0` is the opposite case: it fires only for a Digest that, right now, is
actually incomplete — some chunk of its own Period was skipped — so every time it fires, the Period
it fires for really did lose material. `entries.seq` starts at 1
(`0001_create_entries.sql`), so recording `0` makes `select_is_stale`'s `seq > source_seq`
comparison true for every Entry in the Period, including the ones that made it into the stored
body, the instant the revision is written. The revision is **born flagged stale** — the same marker
ADR 0039 already renders — which is what gets a reader to press Regenerate, the only way this
Period ever improves, since the worker itself never revisits a Digest once one exists regardless of
completeness (`fill_period`'s `max(period_start)` anchor walks past any Period with a row at all). A
complete Digest keeps `source_seq_of(entries)` — the true max `seq` over every Entry the Period
holds — exactly as it always has.

## Alternatives considered

- **Moving the Digest worker onto Reflection's harness (`harness::agent_loop::run`).** Rejected.
  The harness genuinely is general-purpose — its signature carries nothing Reflection-specific, and
  issue #95 already proved a new kind of data (reading a Digest from inside Reflection) costs one
  `AgentTool` implementation, not a redesign. But the loop exists to decide *how much to look*; a
  Digest already knows the answer to that question — every Entry in its Period, full stop. Running
  the loop over a Period would replace a complete, verified Entry set with whatever the model paged
  in before it felt satisfied (tools page at 20 results by default), which is exactly ADR 0031's own
  "strictly weaker claim" about `grounding_entry_ids` under the loop, imported into a place that
  currently has the stronger claim and has no reason to give it up. And once the loop itself is
  rejected, adopting `harness::chat::ChatClient` on its own buys Digest only two things it does not
  need: a never-`Err` contract (Digest already handles `Err` explicitly, at exactly the granularity
  it wants — per chunk), and streaming (nothing watches a background worker's tick the way a reader
  watches Reflection's SSE).
- **`harness::compaction::transform_context`.** Rejected, and traced rather than assumed: given
  `messages = [User(all the Period's Entries)]`, `find_cut_point` returns `1`, `cut > pinned` holds,
  so compaction summarises that one message and hands the model `[SUMMARY_MARKER + summary]` — which
  this function's own chat call would then be asked to summarise a second time. Two lossy passes,
  exactly the summary-of-summaries shape ADR 0027 already rules out, reached through different
  machinery than a manual merge pass would be.
- **A guard that refuses an oversized Period instead of splitting it.** Considered and rejected:
  splitting was chosen specifically so a Digest still gets written for a Period too large for one
  call, rather than leaving it permanently unwritten the way a poison Period already can be
  (ADR 0027's Consequences).
- **Chunking by sub-Period** (a month splitting into its constituent weeks, a week into its days)
  rather than by Entry boundary. Rejected: a single overflowing *day* has nothing smaller below it
  to split into, so the greedy Entry-level path would still be needed for that case regardless — two
  mechanisms, one of which is a strict subset of the other's job, where one already suffices for
  every Period type.
- **A merge or summarise pass over the surviving chunk bodies**, run as one further chat call after
  the chunks are all in hand. Rejected — see Decision: this is exactly the summary-of-summaries
  shape ADR 0027 already ruled out for the cross-Period case, just re-derived one level down inside
  a single Period.
- **Refusing a partial regenerate that would shadow a complete revision.** Considered and rejected —
  see Consequences below for why the stale marker was judged sufficient mitigation instead of a
  write-time guard.

## Consequences

Three risks were raised during design and accepted deliberately, not discovered afterward.

**1. Call multiplication is unbounded.** `MAX_DIGESTS_PER_TICK` is a *write* budget, by its own
doc comment — it counts Digests actually written, not chat calls attempted. A Period that splits
into N chunks costs N calls for one write, so a tick that fills its full write budget across all
three Period types can issue up to 3×N calls in that single tick, and a Period stuck failing every
chunk burns up to N calls per attempt, up to N×`MAX_ATTEMPTS` before the worker gives up on it
entirely — a 4-chunk Period that keeps failing could burn 20 calls before that happens. This is
accepted on the measurement in Context above: no real Period splits today, so this risk is currently
theoretical, not observed.

**2. Regenerate may downgrade a complete Digest to a partial one.** Because reads take the newest
revision unconditionally (ADR 0039), a partial revision minted by a regenerate request can shadow a
complete revision that came before it. The only mitigation is that the new, partial revision is
born flagged stale (`source_seq = 0`), so a reader sees the marker on the very next read and can
press Regenerate again. No "refuse to write a partial revision over a complete one" guard was added
— see Alternatives considered.

**3. A partial Digest is fixed by a human pressing Regenerate, or not at all.** ADR 0039's line —
"the worker generates, it never regenerates" — stays exactly intact under this ADR, so
`fill_period`'s `max(period_start)` anchor walks straight past a partial revision 1 the same way it
walks past a complete one, and no later tick ever revisits that Period on its own.

**The concatenated prose reads as N restarts, not one continuous piece.** `digest_system_prompt`
forbids a preamble but not an opening line, so each chunk's own reply is free to open the way any
standalone Digest would — "You wrote about..." — and concatenating several such openings back to
back reads as several small Digests glued together rather than one. This is an accepted readability
cost of concatenation over a merge pass, not an oversight: a merge call that smoothed those seams
would be the summary-of-summaries this ADR's Decision already rejects.
