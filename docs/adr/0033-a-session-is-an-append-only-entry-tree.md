# 0033: A Session is an append-only entry tree

## Status

Accepted. Amends [0025](0025-sessions-are-held-by-the-server.md): everything 0025 decided about
*where* a Session lives (the Server, exclusively — no local mirror, no `localStorage`, the Session
id in the URL as the only client-side state, asking with no `session_id` as the only way to create
one) stands unchanged and is still load-bearing — except for *when* the `sessions` row is written,
which issue #108 moved to the start of the run (see 0025's own "Amendment (issue #108)" and this
ADR's, both at the end). What this ADR replaces is 0025's assumption about
*what a Session is made of* — a sequence of Question/Answer pairs — which [0031](0031-reflection-is-a-loop-over-tools.md)
made false the moment Reflection stopped answering a Question in one shot. Built in two passes:
issue #91 (`ade832a`) expanded storage to the tree described below while keeping the old table
alongside it; issue #99 (`6bed6b5`) is the contract half this ADR records — the old table is gone
and the tree is the only representation a Session has.

## Context

0025 built `session_turns`: one row per Question, holding its Answer, `grounding_entry_ids`,
`grounded`, and `fallback_used` — a shape that fits exactly what the fixed pipeline
([0023](0023-reflection-is-a-fixed-three-source-fan-out.md)/[0024](0024-the-answering-call-judges-its-own-grounding.md))
produced: one request in, one Answer out, nothing in between worth persisting on its own.

`0031`'s loop does not produce that shape. Answering a Question can now take several model replies
and several tool calls before a final prose reply ends it — the model speaks, calls a tool, reads
a result, and speaks again, however many times that takes. None of that fits "one row per pair."
The intermediate steps are not throwaway, either: they are exactly what
[0034](0034-reflection-reports-its-progress-as-it-runs.md) streams live and what a reload needs to
reconstruct faithfully — a Digest-sourced Answer's provenance, a model change mid-Conversation,
which tool call surfaced which Entry.

Two carry-over defects, found live on the Sandbox while this ticket was being verified, are the
concrete argument for why "per-pair storage, now with extra columns bolted on" was never going to
be enough. `session_turns` had no way to record *which tool* produced an Answer's Grounding, only
a flat `grounding_entry_ids` array: a Question answered from a Digest, correctly disclosed live as
"Answered from the month Digest for 2026-07-01 to 2026-07-31," read back after a page reload as
"Grounded in 10 Entries" — not merely missing its attribution, actively asserting the wrong one,
because the 10 ids came from other tool calls in the same run and `read_digest` itself
deliberately populates none. The data was never lost — `build_tree_payloads` had always persisted
every tool result's `details` into the tree — it was the read path (`session_turns`) that predated
the tree and had nowhere to put it.

## Decision

**`session_entries` is an append-only tree, one row per thing said or done, not one row per
Question/Answer pair** (migration `0006`). Ported from pi's `packages/agent/src/harness/session/`,
where each Session is its own file and entry ids are stable across a fork because nothing else
needs to agree on them.

**The primary key is the composite `(session_id, id)`, not `id` alone.** Every Session shares one
table here (unlike pi's one-file-per-Session layout), so the composite key is what lets a forked
entry keep the exact `id` it had in the Session it was forked from while living in a second row,
in a second Session. `fork_session` (`sessions.rs`) copies a root-to-node path into a new Session
preserving every copied entry's id, and nothing outside tests calls it yet — no HTTP route offers
forking today — which is why it stays `pub(crate)` rather than `pub`. The schema is built for it
regardless, because retrofitting a composite key after entry ids had already been assumed globally
unique would be a harder migration than building it in from the start.

**Reading a Conversation is a walk from a leaf to a root through `parent_id`, then a reverse — with
a cycle check — never `order by seq`.** `sessions::walk_to_root` is deliberately not a `seq`-sorted
select: `seq` alone cannot tell a live lane from an abandoned fork once forking exists, even though
no interface exposes forking yet. `sessions.main_leaf_id` names the single implicit lane this
design supports today — deliberately not pi's named lanes, which this port has no client for.

**Context building starts from the last `compaction` entry on the walked path, not from the
root.** `project_from_last_compaction` trims a walked path down to whatever follows the most
recent `compaction` entry (or leaves it untouched if there is none, which is every path before
issue #97's compaction ever fires). This reuses issue #91's own projection rather than a second
copy of it — the same six-line function issue #97 built compaction against is the whole of pi's
"rebuild."

**`type` is one of `message | model_change | compaction | branch_summary | custom`**, matching
pi's own entry kinds minus the ones this port has no use for yet. The type-specific shape lives in
a `jsonb` `payload` rather than in more columns, because a `session_entries` row that had to carry
a column for every kind's own fields would grow a new nullable column every time a kind was added.

**`session_records` is a separate, non-tree operation log** — `operation_started |
operation_finished | step_attempt | tool_started | abort_requested | usage` — sharing one
strictly-consecutive per-Session `seq` counter with `session_entries` (`sessions.next_seq`,
allocated via `update ... set next_seq = next_seq + 1 ... returning next_seq - 1`, whose own row
lock is what serialises concurrent appends without a separate advisory lock). One counter across
both tables, not two independent ones, because a harness reducer that replays "what happened, in
order" needs a single timeline, not two it has to interleave itself by `created_at` — which, unlike
`seq`, is never guaranteed to strictly increase. **This is an audit trail in this design, not a
resume mechanism**: records are written and readable, but no reconnect-to-an-interrupted-run path
is exposed over the wire. The property that makes it useful for more than an audit trail later — a
record's `id` provisioned *before* the work it describes starts, so "did this tool's result ever
land" is answerable by checking whether the corresponding `session_entries` row exists — is built
in now and left for a future ticket to use.

**Nothing is ever deleted from the tree, and per-pair `session_turns` storage is removed
outright.** Issue #99's contract half: `session_turns` is dropped (migration `0008`), safe because
migration `0006`'s own backfill had already converted every row that existed when it ran into two
chained `message` entries (`user` then `assistant`) — so an old Conversation opens and reads
correctly through the tree alone, simply with no tool steps in it, because it never had any.
`grounded` and `fallback_used`, the columns `session_turns` carried alongside
`question`/`answer`/`grounding_entry_ids`, are not ported forward anywhere — they were the fixed
pipeline's own verdict ([0024](0024-the-answering-call-judges-its-own-grounding.md)), and the loop
that replaced it has no equivalent judgment to store (see [0031](0031-reflection-is-a-loop-over-tools.md)'s
Consequences). `grounding_entry_ids` is not lost: it lives on in a Turn's `assistant` entry
payload, read back by `sessions::entries_to_turns` walking the tree's own `tool_result` entries
directly — never a merged, ranked list computed in advance.

**Removing the fallback this ADR's own contract half required meant fixing where tests seeded
data.** Issue #91 left `sessions::load_turns` a fallback: when a Session had no `main_leaf_id`, it
read `session_turns` directly, because `reflect.rs`'s own tests seeded Conversations by inserting
into `session_turns` without going through `record_turn`, and issue #91 was not scoped to edit
that file. That fallback is exactly why the entry tree was not yet the sole source of truth — a
Session written by some other path would silently read back as empty the moment `session_turns`
was gone. Issue #99 fixed the test seeding to append tree entries directly and removed the
fallback with it: `load_turns` has no fallback left to fall back to, and every Session, however it
was written, now reads from the tree or nowhere.

**`digest_source` and `tool_called` are derived from the tree at read time, not stored columns.**
`entries_to_turns` walks the same `tool_result` entries `grounding_entry_ids` reads and keeps the
last Digest-sourced result it finds (`details.source == "digest"`, the tag issue #95's
`read_digest` tool applies), which is what fixed the carry-over defect described in Context: a
Digest-answered Turn now reads its correct provenance back after a reload, verified live against
the Sandbox. `tool_called` answers "did a tool run at all" (issue #103) the same way — computed
from whether any `tool_result` entry appears in the Turn's own run, rather than a second,
independently-writable flag a future write path could forget to set.

**`list_sessions`'s Search stopped joining `session_turns` and now searches `session_entries`'
payloads directly.** This was not named in issue #99's own acceptance criteria, but dropping
`session_turns` while Search still queried it would have silently broken Session search entirely —
a regression the issue's text never called out, caught and fixed as a direct consequence of
removing the table rather than a separate scope decision.

## Alternatives considered

- **Keep `session_turns` as a derived, denormalized read cache over the tree**, rewritten on every
  Turn rather than dropped. Rejected: it reintroduces exactly the two-sources-of-truth problem
  issue #91's own expand-and-contract framing was designed to retire, and the carry-over defect in
  Context (a stale, wrong "Grounded in 10 Entries" after reload) is precisely what a derived cache
  that can fall out of step with the tree produces. The tree is cheap enough to walk on every read
  (`load_entries` pulls a whole Session's tree in one query) that a cache buys speed nobody has
  measured a need for, at the cost of a second representation that can disagree with the first.
- **Add `digest_source` and `tool_called` as real columns on a per-pair table, instead of building
  the tree at all.** This is what the carry-over note attached to issue #96 explicitly declined to
  do: "bolting a field onto the per-pair row #99 exists to delete" would have fixed one instance of
  the underlying problem (Digest attribution) while leaving every future per-tool detail needing
  its own bolted-on column. The tree's `payload` jsonb already generalizes to any tool's `details`
  without a schema change per tool.
- **Give every `session_entries` row a single global `id` rather than a composite
  `(session_id, id)` key.** Rejected because it forecloses forking preserving entry ids, which pi's
  own design relies on and which this port keeps available even with no client yet — see Decision.
- **Expose `session_records` as a resume/reconnect endpoint in this same ticket.** Rejected as
  scope: issue #91 already named this as a later ticket's surface, not this one's job, and nothing
  here needed it to satisfy `0031`'s loop or `0034`'s live progress reporting.

## Consequences

**`Turn` is used two different ways across this codebase now, and that ambiguity is inherited by
this ADR rather than created by it.** `sessions.rs` and `reflect.rs` both still use "Turn" to mean
a whole Question/Answer exchange — `SessionTurnRow` ("one Question/Answer pair, rebuilt from a
Session's entry tree"), `record_turn`, `prior_turns`, `CONVERSATION_WINDOW`'s "how many of a
Session's most recent Turns" — exactly the sense 0025 used it in. `agent_loop.rs`'s own vocabulary
(`LoopEvent::TurnStart`, and the `turn_start` SSE event it becomes on the wire in
[0034](0034-reflection-reports-its-progress-as-it-runs.md)) uses "turn" for one loop iteration —
one model reply, plus whatever tool calls it made — which is a *piece* of what `sessions.rs` calls
a Turn, not the same thing. CONTEXT.md is updated to define the domain term Turn as the
loop-iteration meaning, per issue #99's own instruction. **This leaves the dominant Rust
identifiers (`SessionTurnRow`, `record_turn`, `prior_turns`) naming the older, now-superseded
sense of the word** — a real inconsistency between the glossary and the code's own naming that
this docs-only pass records rather than fixes, since renaming those identifiers is a code change
outside this ticket's scope.

**A Conversation reload after a Digest-sourced Turn now shows correct provenance**, closing the
gap [0034](0034-reflection-reports-its-progress-as-it-runs.md)'s own client pass (`871b00b`)
recorded as its "honest limit": a distinction that survived only until reload now survives it,
because the read path (`entries_to_turns`) finally reads from the same tree the write path
(`build_tree_payloads`) had always written completely.

**The tree's `payload` jsonb has no schema Postgres enforces beyond the `type` check constraint.**
A malformed or unexpected payload shape for a given `type` is a bug `entries_to_turns` will
encounter at read time, not something the database itself can catch at write time — the same trade
every jsonb-payload design makes, accepted here for the same reason issue #91 accepted it: a
column-per-kind schema would need a new migration every time a new entry kind's fields were added.

## Amendment (issue #108): the operation log is written, and what that costs

This ADR built `session_records` alongside the entry tree and described it as "written and readable."
Issue #108 found that only the second half was true: `append_record` had no production caller, and
the table was empty in every running instance. The storage, the API and the tests were all correct;
the wiring was simply absent. It is now wired, through a narrow async `RunLog` port
(`harness/run_log.rs`) that `agent_loop` writes through — the loop still names nothing from HTTP,
Sessions or Postgres, which this ADR's own boundary requires; `reflect.rs` supplies the
implementation over a `PgPool`, the same seam `ChatClient` already draws.

Two consequences are worth recording rather than leaving to be rediscovered.

**Within one Turn, every record sorts before every entry.** Entries and records share one strictly
consecutive `seq` per Session, which this ADR treats as "the order things happened." That reading is
now approximate. A record commits the moment the loop reaches it, in its own short transaction,
because a record that waits for the end is worthless to a run that crashes; entries still commit
together at the end, once an Answer exists. So a `tool_started` record always carries a lower `seq`
than the `session_entries` row it reserved the id for, even though the two describe the same moment.
Anything replaying a Session in `seq` order has to know this. The alternative — writing entries
incrementally too — was rejected because it would put half-written Turns in the tree on every failed
run, which is the guarantee [0025](0025-sessions-are-held-by-the-server.md) is right to keep.

**Reserving the identity before the work is the part that carries the payoff.** `tool_started` mints
the `Uuid` that the tool's eventual `tool_result` entry will carry and hands it back, so the loop
threads it through to the write. "Did this tool's result ever land?" is then answered by asking
whether a `session_entries` row with that id exists — which is what migration `0006` said this table
was for, and what could not be asked while ids were minted at write time.

One record kind is inert: `abort_requested` is wired faithfully but no `ChatClient` in production
produces `StopReason::Aborted`, so nothing triggers it until a real cancellation path exists. Said
here rather than left as a puzzle for whoever greps for its writer.
