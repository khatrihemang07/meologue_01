# 0039: Digests gain revisions and can be asked for

## Status

Accepted. Supersedes two specific clauses of
[0027](0027-digests-are-written-ahead-of-time-by-a-background-worker.md) — its Decision's "at most
one Digest per Period," enforced by the `unique (period, period_start)` constraint on `digests`,
and its underlying design premise that "nothing asks for a Digest, ever" (CONTEXT.md's Digest
entry, quoted in 0027's own module comment). Both give way to "at most one Digest per Period per
revision, reads take the newest," and to a synchronous route that can ask for a fresh one.

**0027's immutability clause stands unchanged and is still load-bearing.** "A Digest is immutable,
so a late-Syncing Entry for an already-Digested Period is simply not in it" is exactly as true
after this ADR as before it — no row this ADR touches is ever mutated; every write is a new INSERT.
What was superseded is the *count* of rows one Period may hold, not whether any one of them can
change once written. `server/migrations/0004_create_digests.sql`'s own header — "Written once ...
and never again" — remains word-for-word accurate; only "once" now means "once per revision."

Extends 0027's worker shape unchanged: the background worker still ticks on `SCAN_INTERVAL`, still
finds writable Periods with the same resume rule, and still writes only a first-generation Digest.
Nothing in that machinery is touched here except the one guarantee this ADR adds to it — it must
never write a second revision.

Extended by [0040](0040-a-digest-body-is-validated-once-and-chunked-when-it-must-be.md), which puts
a single validated step in front of both the worker and the regenerate route this ADR adds, and
lets that step split an oversized Period across several chat calls. Nothing here — the revision
count, the staleness watermark, "the worker generates, it never regenerates," or reads taking the
newest revision unconditionally — is superseded by it.

## Context

Issue #132's report is two things wearing one shape. Edit an Entry from a day that already has a
Digest, and the Digest silently keeps describing what was there before the edit — 0027's own
Amendment (ADR 0028) already named this as an accepted limitation, but named no way out of it.
Separately, a Period whose generation failed every one of `digest.rs::MAX_ATTEMPTS` retries is
indistinguishable from a Period nobody has looked at yet: the attempt count is process-local (0027's
own Consequences: "there is no equivalent query that reveals a Period stuck past `MAX_ATTEMPTS`"),
so a permanently poison Period simply never gets a row, forever, with nothing short of a database
console visible from inside the app to say so.

0027's "nothing asks for a Digest, ever" was not an oversight; it followed directly from a fact
that was true when it was written and is no longer true. At the time 0027 shipped, an Entry was
immutable — CONTEXT.md described it as "captured, and never rewritten" — so a Digest reading a
Period's Entries once, ahead of time, could never fall behind: there was nothing about a Period
that could still change after its Digest was written, short of a late Sync, which 0027 already
handled by simply excluding what arrived too late. **ADR 0028 made an Entry mutable** — editable
and deletable, with `entries.seq` reassigned on every change to track last-touch order — and that
is exactly the premise 0027's "never asks" design leaned on without saying so. Once an Entry can
change *after* its Period was Digested, "the Digest read everything there was to read, once" stops
being true by construction and becomes true only until the next edit. 0027 predates 0028 by one
ADR number and, on this one point, by an assumption 0028 quietly retired. This ADR is what happens
once that gap is named rather than left implicit.

## Decision

**`digests` gains `revision` and `source_seq`** (`server/migrations/0009_digests_gain_revisions.sql`).
`revision` starts at 1 and increments per successive write for the same `(period, period_start)`;
the old `unique (period, period_start)` constraint becomes `unique (period, period_start,
revision)`, so a second write no longer collides with the first — it coexists beside it.
`source_seq` records the highest `entries.seq` among the Entries a given revision was written
from (`0` when the Period held none), and is what makes staleness a query rather than a guess.

**Staleness reuses the Sync change log ADR 0028 already built, rather than adding anything to
`entries`.** ADR 0028 rejected an `updated_at` column by name — "nothing ever compares one" — and
that reasoning stays intact: nothing on `entries` compares a timestamp. What changed is that
something now compares a *sequence number* against a Digest's own watermark:

```sql
select exists (
  select 1 from entries
  where created_at >= $period_start and created_at < $period_end
    and seq > $digest_source_seq
)
```

An Entry's `seq` is reassigned from the sequence on every insert, edit, and delete
(`sync.rs`'s `on conflict do update ... seq = nextval(...)`, ADR 0028), so "some Entry's `seq` now
exceeds the watermark this Digest was written against" is exactly "some Entry in this Period has
moved since." `created_at` stays immutable across an edit, so the range predicate that buckets an
Entry into its Period never has to be recomputed — only the comparison against `source_seq` does.
The predicate deliberately never filters `deleted_at`: a deletion is exactly the kind of change a
reader should be told about, not one that should quietly stop counting the moment it happens.
`stale`, `revision`, and the revision's own `created_at` are exposed on the wire (`Digest`,
`server/src/digest.rs`) so a client can render both the marker and the provenance cue without a
second request.

**The worker still generates; it never regenerates.** `insert_digest` is unchanged in spirit —
still `revision = 1`, still guarded so it only ever writes where no Digest exists for that Period
at all — and now also records `source_seq`. Nothing about `fill_period`'s resume rule changes: once
any revision exists for a `(period, period_start)`, `latest_digest_start`'s `max(period_start)`
anchor walks past it exactly as it always has, so a stale Period sitting in the worker's own
backlog is never revisited by a tick. The worker has no idea what "stale" means and never needs to.

**A Digest can be asked for, synchronously.** `POST /v1/digests/{period}/{date}/regenerate`
(`digest::regenerate_digest_handler`) reuses `select_entries` and `build_messages` — the exact
machinery `write_digest_for` already builds a chat call from, including `digest_system_prompt`'s
"You are the Digest writer" opening, the leading phrase two independent test doubles
(`server/tests/digest.rs`'s `is_digest_call`, `apps/e2e/llm-stub.ts`'s `isDigestCall`) sniff to
recognise a Digest call at all — and inserts at `coalesce(max(revision), 0) + 1` for that exact
`(period, period_start)`. `coalesce(..., 0) + 1` resolves to plain `1` when nothing was ever
written, which is what makes this route double as the rescue for a Period stuck past
`MAX_ATTEMPTS`: the same request that regenerates a stale Digest can also mint a Period's first row
where the worker never managed to. It runs the chat call inline and returns the new revision in the
response — a reader pressed a button and is watching, so a spinner is honest feedback, and there is
no hint to hand a poller the way the worker's own tick has none to react to either.

**Reads always take the newest revision; there is no revision picker.** `select_latest_digest` and
`select_digest_at` both add `order by revision desc` (the latter also breaking `period_start` ties
the same way). A reader sees exactly one Digest per Period, ever — the newest — with a provenance
cue (its own `revision`/`created_at`) distinguishing "the Server wrote this by itself" from "you
asked for this." Older revisions stay in the table, readable only by direct query, because nothing
in this codebase has a reason to show one.

## Alternatives considered

- **Overwriting the existing row in place.** The most direct fix for staleness, and rejected for
  the same reason 0027 chose immutability in the first place: it destroys what the Server actually
  said at the time it said it, which is not free to discard — the point of a Digest is that it is
  the Server's own record of a stretch of time, and a record that can be silently rewritten is not
  one. It also rewrites CONTEXT.md's own term: "A Digest is immutable once written" would become
  false, not merely incomplete, the moment any write updated a row instead of inserting one.
- **Enqueueing a regenerate request for the background worker to pick up on its next tick.**
  Preserves 0027's shape exactly — the worker remains the only thing that ever writes — but
  `digest::SCAN_INTERVAL` is 300 seconds. A reader who presses Regenerate and watches a spinner for
  up to five minutes is not a synchronous action with honest feedback; it is a queued job wearing a
  button's clothes. The ticket's whole premise — "you pressed a button and are watching" — requires
  the chat call to happen inline, which requires a request handler that can make one, not a queue
  the worker drains on its own schedule.

## Consequences

**A Period past `MAX_ATTEMPTS` has a rescue for the first time.** 0027's Consequences named this
gap and left it open — "a real gap a later observability pass should close, not one this ticket
claims to have solved." This ADR does not add the alerting 0027 deferred, but it closes the
practical half of the gap: a reader who notices a missing Digest (by its absence, still with no
alert) can now make one exist by asking, rather than waiting on a worker that has already given up.

**Every earlier revision stays in the table, unread by anything but a direct query.** This is
accepted, not optimized away — a `digests` row is small, a Period is Digested at most a handful of
times in practice, and pruning old revisions would need a policy (keep how many? for how long?)
nothing in this codebase currently needs an answer to.

**`packages/core/src/generated/wire.ts` gained `stale`, `revision`, and `written_at` on `Digest`,
plus the new `regenerate` operation** (`pnpm --filter @meologue/core generate:wire-types`). No
existing wire field changed shape; every prior client reading `Digest` keeps working unchanged.

**Concurrent regenerate requests for the same Period are not fully race-free.** `regenerate_insert`
computes `coalesce(max(revision), 0) + 1` inside one `insert ... select` statement rather than in a
separate read-then-write step, which closes the obvious window, but two truly simultaneous requests
can still both compute the same next number under Postgres's default isolation; the `unique
(period, period_start, revision)` constraint still prevents either from landing twice, so the loser
surfaces an ordinary error rather than corrupting anything. This is accepted for a single-user
journal with at most a handful of Devices — not a system with the kind of write contention that
would justify a lock for it — the same proportionality 0027 already applied to `insert_digest`'s
own `on conflict do nothing`.
