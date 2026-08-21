# 0027: Digests are written ahead of time by a background worker

## Status

Accepted. Extends [0021](0021-the-server-calls-an-openai-compatible-llm.md) (the chat egress this
worker's one call spends, and the "unset config means the feature is off" rule this ADR applies to
`digest_worker_config` too), [0022](0022-entry-embeddings-are-filled-by-a-background-worker.md) (the
worker shape — a `tokio::spawn` off a periodic tick, an injectable interval, a process-local attempt
cap — copied here almost verbatim for a different queue), and
[0023](0023-reflection-is-a-fixed-three-source-fan-out.md) (specifically, its rule that the Server
never guesses a timezone from its own clock — see the `MEOLOGUE_TZ` section below for why this ADR
extends rather than contradicts that). Nothing in any of the three is superseded; this ADR only
records what got built on top of them.

## Context

CONTEXT.md's Digest entry describes prose the Server writes about a stretch of time without being
asked — a day, a week, or a month (Period). Nobody sends a request that produces a Digest; it has to
already exist by the time anyone would want to read it. That means something has to notice, on its
own, that a day has ended and wrote what happened, in exactly the same "off the request path, on a
loop" shape ADR 0022 built for embeddings — and for the same underlying reason: nothing about Sync or
Capture should ever wait on or depend on an LLM call succeeding.

The harder problem ADR 0022 didn't have to solve is where to start. An embedding backlog is bounded
by "every Entry that doesn't have one yet," which converges to zero and stays there. A Digest backlog
has no such natural bound: the reference test corpus holds Entries going back roughly 180 days, and a
worker that took "every completed Period since the journal began" literally would, on a fresh
install, immediately place roughly 180 daily chat calls, another ~25 weekly ones, and another 6
monthly ones — against an LLM endpoint that, per ADR 0021, may not even be fast or cheap. That is not
a slow start; it is a worker that DOSes its own configured backend the moment it's turned on.

## Decision

**A background worker on a tick, not a cron.** `server/src/digest.rs::run` is spawned once from
`main.rs`, wakes on `tokio::time::interval(scan_interval)`, and asks a state question every time it
wakes: "which completed Periods have no Digest yet?" This is deliberately not a cron firing at each
Period's own boundary (midnight, the start of ISO week, the 1st of the month). A cron that fires once
and finds the Server down has lost that firing forever — nothing else will ever ask for it again. A
state rule has no such failure mode: whatever a downed cron would have missed is still exactly what
the next tick's question finds true, so the worker catches up as soon as it's running again, with no
special-cased recovery path to write or test.

**The resume rule, and the no-anchor clause that makes it safe on a fresh install.** For each Period
type independently: find `anchor`, the most recent Digest of that type; find `horizon`, the newest
Period of that type that has fully completed as of now
(`period::most_recently_completed`). If `anchor` exists, the next Period after it is the first one
eligible — a plain forward walk. **If no `anchor` exists at all, the only eligible Period is
`horizon` itself.** That clause is the entire point of this ticket: without it, a fresh install's
first tick would treat "no anchor" as "start of time" and generate a Digest for every day, week and
month the journal has ever held — the DOS scenario above. With it, a cold start writes at most three
Digests (the most recently completed day, week, and month) and never looks further back than that,
regardless of how much History already exists.

**Forward-only was chosen over backfilling the ~180 days of history the test corpus holds.** A design
that backfilled would need to decide *how far* back to reach — there is no principled floor short of
"the journal's first Entry," which is exactly the unbounded case being avoided. Forward-only accepts
a real, visible gap (no historical Digests for time before this feature existed) in exchange for a
bound that needs no configuration and no judgment call about how much history is "enough." See
Consequences.

**Seeding one row is the whole backfill mechanism, and that's why the rule anchors to the last
Digest rather than to a separately tracked cursor.** Insert a single `digests` row with whatever
`period_start` an operator wants Digests to begin from, for whichever Period type, and the very next
tick's resume rule reads it as `anchor` and walks forward from there — filling in every completed
Period after it, at `MAX_DIGESTS_PER_TICK` per tick, with no code path dedicated to backfilling and no
separate state to keep in sync with `digests` itself. This is also how this ticket is verified against
the real 572-Entry corpus: seed one old row, watch the worker fill forward.

**A Digest is immutable, so a late-Syncing Entry for an already-Digested Period is simply not in it.**
This matches Entry's own immutability (CONTEXT.md) rather than inventing a new rule: an Entry, once
captured, is never rewritten to reflect something that happened after it; a Digest, once written, is
never rewritten to reflect an Entry that arrived after it. The `unique (period, period_start)`
constraint on the `digests` table (`migrations/0004_create_digests.sql`) makes this structural — a
retry or a race can only ever no-op against it, never overwrite — rather than a discipline the worker
code has to maintain by checking first. The alternative, tracking which Digests a late Sync might
have invalidated and regenerating them, is exactly the kind of invalidation-tracking machinery Entry
immutability was chosen to avoid needing anywhere in this codebase.

**A Digest reads Entries directly, at every Period, never other Digests.** A weekly Digest reads the
week's Entries, not its seven daily Digests; a monthly Digest reads the month's Entries, not its
four-or-five weekly ones. Summarising a summary would make a weekly Digest depend on every daily
Digest existing first (an ordering dependency the resume rule above has no reason to need) and would
compound whatever a daily Digest already left out or got slightly wrong at every hop upward. Reading
the same source Entries at every granularity costs more tokens in aggregate but keeps every Digest an
independent, first-generation summary of what was actually written.

**`MEOLOGUE_TZ` decides which local day, week or month an Entry belongs to, and this extends ADR
0023 rather than contradicting it.** ADR 0023 established that the Server never *guesses* the
timezone — a Device injects its own UTC offset on every `/v1/reflect` request, because assuming the
Server's own clock represents the user's timezone would silently misresolve "yesterday" for anyone
elsewhere. That rule is about *guessing*; a Digest worker has no request to read an offset from at
all; there is no Device in the loop when a tick fires. A configured `MEOLOGUE_TZ` is not a guess — it
is an explicit, visible operator decision about which timezone this Server's calendar boundaries
follow, read once at startup (`period::server_timezone`) and used consistently for every Period this
process ever computes. Defaulting to UTC when unset is the same "off means a defined, harmless
default" shape ADR 0021 already uses for the chat/embed variables; an unparseable value warns and
also falls back to UTC (`period::parse_timezone`) rather than refusing to start, because a
misconfigured timezone should degrade the worker's boundaries, not take the whole Server down.

**All timezone and calendar maths lives in `server/src/period.rs`, and SQL never does `at time
zone`.** Every function that buckets an instant into a Period, walks a Period forward or backward, or
turns a Period start into a UTC instant range lives in this one pure module — no database access, no
`Utc::now()` called internally (every function takes "now" as a parameter, mirroring the
`scan_interval` seam ADR 0022 established). `server/src/digest.rs` pulls raw UTC timestamps out of
Postgres and buckets them in Rust; it never asks SQL to do that bucketing itself. Two independent
implementations of "what local day does this instant fall on" would drift the instant either one
changed without the other, and the failure mode — an Entry silently landing in the wrong Period, or
in none — is exactly the kind of bug that stays invisible until someone reads the wrong Digest.

## Alternatives considered

- **A cron/scheduled job, firing at each Period's own boundary.** Rejected — see Decision: it loses
  a firing permanently if the Server is down at the moment it would have fired, with no way to notice
  or recover short of a human checking.
- **A bounded lookback window (e.g. "always consider the last 30 completed days") instead of the
  anchor rule.** Rejected: it either misses history a longer outage created (a window shorter than
  the outage) or reintroduces the exact unbounded-backfill risk this ticket exists to avoid (a window
  long enough to always be safe). The anchor rule has no such tension — it always resumes from exactly
  where it left off, however long that gap was.
- **A config-supplied floor date, below which no Digest is ever generated.** Rejected: it's one more
  environment variable to explain and get wrong, for something the no-anchor clause already handles
  without any configuration — a fresh install needs no floor because it has no anchor yet, and an
  operator who wants a specific starting point can seed one row (see Decision) instead of tuning a
  date.
- **A persisted "worker started at" row, used as the effective floor for a fresh install.** Rejected:
  it adds a second piece of state that has to agree with `digests` (what happens if a row is deleted,
  or startup crashes right after writing it?), for something anchoring to the actual last Digest
  already gives for free, and gives more precisely — a real Digest is proof a Period was
  filled, not a guess about when the worker happened to first run.
- **A backfill subcommand or admin action, run once by an operator to fill historical Digests on
  purpose.** Not rejected outright — genuinely useful for someone who wants their journal's full
  history Digested — but out of scope for this ticket, and not needed to satisfy the acceptance
  criteria. Seeding one row and letting the ordinary resume rule walk forward (Decision, above)
  already gives an operator everything a dedicated subcommand would, just phrased as a database write
  instead of a CLI flag.
- **Per-Entry UTC offsets, persisted at Sync time, so a Digest could use each Entry's own Device's
  timezone instead of the Server's configured one.** This is the "ideal" version of correctness — an
  Entry written at 11:58pm on a Device three timezones away really did happen on a different local
  date than the Server's clock would bucket it into — and it was dropped for this ticket rather than
  built. It stays available to add later: nothing here forecloses it, and because a Digest is
  immutable once written, choosing not to have it now costs nothing that waiting can't recover —
  Digests written under `MEOLOGUE_TZ` today are not invalidated or made wrong by a future ticket that
  starts recording per-Entry offsets; they simply used the information available when they were
  written, the same way an Entry Synced before that ticket would.
- **Summary-of-summaries** (weekly reads daily Digests, monthly reads weekly ones). Rejected — see
  Decision: it creates an ordering dependency this design has no other reason to need, and compounds
  lossiness at every hop rather than keeping every Digest a first-generation read of the actual
  Entries.
- **Regenerating a Digest when an Entry Syncs in late for its Period.** Rejected — see Decision's
  immutability point: this would need to track which Digests a late Entry invalidates, the exact
  machinery Entry's own immutability was chosen specifically to avoid needing.

## Consequences

**A Period that permanently fails to get a Digest is invisible.** Unlike `select count(*) from
entries where embedding is null` (ADR 0022's operational health check, which trends to zero and
stays there), there is no equivalent query that reveals a Period stuck past `MAX_ATTEMPTS` — the
attempt count is process-local and gone on restart, and a `digests` row simply never appears for that
`(period, period_start)`. This is accepted in the same spirit ADR 0022 accepted the analogous gap for
a poison Entry: this ticket adds no alerting for it, which is a real gap a later observability pass
should close, not one this ticket claims to have solved.

**The first day after install shows nothing, and the monthly card can show nothing for up to a
month.** The no-anchor clause that makes a fresh install safe also means a fresh install has *no*
Digests at all until the first Period of each type completes — a new Server's first calendar day
produces no daily Digest (there was no *completed* day yet when it started), and a new Server started
mid-month won't show a monthly Digest until the following month begins. This is the direct, accepted
cost of choosing forward-only over backfilling: a Digest only ever exists for time the worker was
actually running to see complete, and "nothing shows up for a while after install" is the visible
version of that trade, most likely to be the first thing a new operator notices.
