# 0063: Health reports effective capability, from in-memory flags

## Status

Accepted. Amends [0037](0037-health-reports-server-capabilities-and-destinations-lock-on-them.md),
which computes `HealthCapabilities` from the same `LlmConfig` that gates route registration.
Re-affirms [0010](0010-reachability-is-a-dedicated-health-endpoint.md) — see Decision, because at
first reading this ADR appears to contradict it and does not. Follows
[0062](0062-a-feature-toggle-is-tri-state-and-idles-a-worker.md), which creates the state being
reported.

## Context

ADR 0037 gave `/v1/health` a `capabilities` object — `{reflect, digest, embeddings, todo}` — and
made it authoritative for whether a Device locks a Destination row. Its central guarantee is that
those booleans are computed from *the same* resolved configuration that decides which routes get
registered, "so health can't disagree with the routes."

ADR 0062 breaks that coincidence deliberately. A feature can now be configured — routes registered,
worker spawned — and switched off anyway. Under 0037's rule as written, health would keep reporting
`digest: true` for a Digest that is not being written, and the chat list would keep the row
unlocked. Health would be reporting the existence of a route rather than a truth about the Server.

**And here is the apparent conflict.** ADR 0010's Decision says, of the health handler:

> The handler touches nothing but its own two constants — no state extraction, no query. A Server
> whose Postgres is down still answers `/v1/health` correctly, which is the property that makes it
> useful as a reachability check in the first place.

Its Alternatives section then explicitly *rejects* having health verify the database. And
`server/tests/health.rs::it_answers_with_no_database_available` pins the property with a pool
pointed at an unreachable address, its comment noting that this "proves the handler answers without
the database, rather than merely against a database that happens to be reachable in test."

The toggle state ADR 0062 introduces is stored in Postgres. Read naively, reporting it from health
is exactly what 0010 refused.

## Decision

**`capabilities.X` reports effective capability: configured AND switched on.** A feature that is
configured but off reports `false`, so a Device locks its row for the same reason and by the same
mechanism it already does. `todo` remains an unconditional `true` — Todo has no configuration and no
toggle, so there is nothing for it to read.

**The conflict with 0010 is resolved structurally, not by exception.** The handler does not read the
database. It reads three `AtomicBool`s held in memory, seeded once at startup from the stored row
and mutated only by a successful config write. `health_handler` gains a `State<RuntimeFlags>`
extractor and nothing else; it still has no `PgPool` in its signature, so the guarantee is enforced
by the type system rather than by anyone remembering it.

ADR 0037 already walked half of this path and said so in its own Consequences: when it added
capabilities, health went from "no state extraction" to extracting two things, and it defended the
half that actually matters —

> `health_handler` still never touches `PgPool` — 0010's DB-free guarantee holds structurally, not
> by convention, because the handler's extractors don't include it.

So 0010's "no state extraction" clause was already relaxed, once, by 0037. What has never been
relaxed, and is not relaxed here, is the database-independence that clause existed to protect. The
distinction matters: 0010's Context explains that the point of a DB-free health check is that
"the database is unreachable" and "the Server is unreachable" must not look the same to a Device.
In-memory flags preserve that exactly.

Postgres is read for this data twice per configuration change — once at startup, once inside the
config write that changes it. The startup read introduces no new failure mode, because migrations
already run at boot and already abort if Postgres is unreachable: a Server that cannot read its
settings row was never going to start. If Postgres dies *after* boot, health keeps answering from
memory, unchanged.

**This reasoning is load-bearing and must stay findable.** A future reader who encounters "health
reports state that lives in the database" without it will either revert this ADR or, worse,
"simplify" the atomics into a query and quietly destroy 0010's guarantee.
`server/tests/health.rs::it_answers_with_no_database_available_and_a_flag_off` pins it: health
answers 200, with a capability reported `false`, against an unreachable pool.

## Alternatives considered

- **Leave capabilities config-derived and let health disagree with reality.** Rejected: the Reflect
  row would stay unlocked while Reflection was off, so a Device would offer an action that answers
  503. That is worse than the staleness 0037 already tolerates, because it is not staleness — it is
  a permanently wrong answer.
- **Add a separate `enabled` object beside `capabilities`.** This leaves 0037 untouched by the
  letter of it. Rejected because it creates two near-identical concepts — "is configured" and "is
  on" — that every client must remember to combine correctly, forever, to answer the only question
  anyone actually asks. One computation with two readers is what 0037 says it exists to protect.
- **Read the stored row on each health request.** Rejected outright: this is the thing ADR 0010
  refuses, and it would make a Postgres outage indistinguishable from an unreachable Server.
- **Keep flags only in the workers and let health infer.** There is nothing to infer from; a worker
  that is idling looks exactly like a worker that is busy.

## Consequences

Health now answers the question a Device is actually asking — "will this Server do the thing if I
ask?" — rather than "does this Server have a route for it?". That is a stronger promise than 0037
made, and the existing client-side row locking gets it for free.

ADR 0037's recorded staleness consequence gets sharper. It notes that the capability cache can be
stale until the next background refresh and adds no push channel, which was tolerable when
reconfiguring meant editing a file and restarting. It is not tolerable when someone flips a toggle
and expects a row to unlock. No new mechanism is added: the Settings surface refreshes capabilities
after a successful config write, exactly as saving a Server URL already does, so the staleness
window is now bounded by the Save that caused it.

`RuntimeFlags` is now shared mutable state, which this Server has otherwise avoided. It is bounded
deliberately: three booleans, one writer, `Relaxed` ordering because nothing is published alongside
them, and a durable row in Postgres that remains the record of record. The atomics are a cache of
that row, re-derived at every boot.
