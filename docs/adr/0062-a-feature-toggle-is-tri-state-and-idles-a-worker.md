# 0062: A feature toggle is tri-state, and it idles a worker rather than unregistering a route

## Status

Accepted. Extends [0021](0021-the-server-calls-an-openai-compatible-llm.md), whose "an unset config
value means the feature is off, not misconfigured" rule now has a second, independent companion:
a feature can also be off while remaining fully configured. Extends
[0022](0022-entry-embeddings-are-filled-by-a-background-worker.md) and
[0027](0027-digests-are-written-ahead-of-time-by-a-background-worker.md), whose workers gain a flag
to consult. Builds on [0060](0060-server-settings-are-a-stored-overlay-on-the-environment-and-the-ui-wins.md),
which is what makes a toggle storable in the first place.

## Context

ADR 0021 gave this Server exactly one way to turn an LLM-backed feature off: leave its configuration
unset. That was the right rule when configuration lived only in `server/.env`, because the two facts
genuinely coincided — a Server with no chat endpoint could not do Reflection, and there was nothing
else to say.

ADR 0060 separates them. Configuration is now a stored overlay that a Device can change, and once a
Device can write a model name it will also want to say "stop using it for a while" without erasing
it. Under 0060's rules, clearing a field means "fall back to the environment", not "off" — so
emptying the model name on a Server whose `.env` still names one turns nothing off at all. Something
else has to carry the meaning.

The pressure behind this is not abstract. The embedding worker (ADR 0022) is *ambient*: it wakes on
a 30-second tick and on every Sync hint, and grinds through whatever is unembedded whether or not
anyone asked. Reflection is *demand-driven*: it costs nothing until a Question is asked. A person
running the model on the same laptop as the Server feels those two very differently, and this
repository has already recorded the difference — `server/tests/eval-retrieval-baseline.md` notes
that the local embedding model "has previously degraded badly under repeated embedding load". Being
able to pause the ambient work while keeping the free-when-idle work is the whole point.

The obvious implementation — stop registering the routes — is not available. ADR 0021 and
[0037](0037-health-reports-server-capabilities-and-destinations-lock-on-them.md) make route
registration a decision taken once, at boot, from the resolved configuration: `/v1/reflect`,
`/v1/sessions*` and `/v1/models` exist only when chat resolves, `/v1/digests/*` only when Digest
does, and the background workers are conditionally spawned in the same pass. Rebuilding the router
at runtime would mean rebuilding all of that, and would reopen two ADRs to do it.

## Decision

**A toggle is tri-state: unset, on, off.** `NULL` in the stored row means "unset" — defer entirely to
what configuration makes available, which is the behaviour every Server had before this ADR.
`true` and `false` are an explicit override. Three states are necessary rather than tidy: with
0060's rule that clearing a field falls back to the environment, `unset` and `off` are genuinely
different intentions, and a boolean cannot hold both. The columns are nullable booleans, so SQL's
own three-valued logic carries the distinction rather than an encoding this codebase would have to
remember.

**A toggle idles work; it does not remove routes.** Route registration stays exactly as ADR 0021 and
0037 shaped it — a boot-time decision from resolved configuration. What a toggle changes is what
the already-running process does:

- The embedding worker consults its flag on **both** arms of its `tokio::select!` — the interval
  tick and the Sync hint — so a hint arriving while embeddings are off is drained and dropped rather
  than queued. The periodic scan re-finds the Entry later, which is the same degradation ADR 0022's
  design already accepts whenever no sender exists.
- The Digest worker consults its flag immediately after its tick, before the Period sweep.
- Reflection consults the embeddings flag when it assembles its tool set, so `similar_entries` is
  simply not offered while embeddings are off. That keeps the invariant the surrounding code already
  protects: the prompt never advertises a tool that would fail.

**A route whose feature is toggled off answers 503, never 404.** The client transports read 404 as
"this Server predates the feature" — a genuinely different fact, and one that would make an older
Server and a paused feature indistinguishable. 503 says "this Server has it and is not doing it
right now", which is true.

**Reading past Sessions is deliberately unaffected.** `/v1/sessions*` keeps answering while
Reflection is off. Listing and opening a Conversation is a plain SQL read with nothing model-backed
about it, and a switch whose purpose is to stop spending CPU has no business hiding Conversations
that already exist.

**On-to-off is live; unconfigured-to-configured is not.** Because routes are still registered at
boot, configuring a feature on a Server that started without it cannot take effect until a restart.
That asymmetry is honest rather than accidental, and `GET /v1/config` reports it per feature —
computed from what the router actually registered, not inferred by the client.

## Alternatives considered

- **Register every route unconditionally and gate purely on runtime state.** This would make
  unconfigured-to-configured live too, which is the one thing the chosen design cannot do. Rejected
  because it inverts ADR 0021's "unset means the feature does not exist" into "unset means the
  feature is off", which is a larger change than the problem needs, and because it would break
  0037's guarantee that health and the route table are computed from one thing.
- **A boolean toggle instead of tri-state.** Rejected: it cannot distinguish "I have never expressed
  an opinion" from "I want this off", and under ADR 0060 those lead to different behaviour on a
  Server whose environment still names a model.
- **Rebuild the router and respawn workers on a config write.** Genuinely live for everything, and
  by a wide margin the most invasive option — it would make the router a mutable, shared, replaceable
  thing purely to serve a setting that changes rarely. Rejected as disproportionate.
- **404 for a toggled-off route.** Rejected: it collides with the meaning the client transports
  already assign to 404, and would make a paused feature look like an out-of-date Server.
- **Refuse `/v1/sessions*` too, for consistency.** Rejected. Consistency with what? The toggle exists
  to stop the Server spending resources on a model; reading a stored Conversation spends none.

## Consequences

A Device can pause the ambient embedding work — the part that actually costs a shared laptop its
CPU — without giving up Reflection, and without a terminal or a restart. Turning it back on resumes
the scan within one interval.

Pausing defers work rather than removing it. Entries captured while embeddings are off accumulate
unembedded, and switching back on drains that backlog in one sustained run — which is precisely the
load shape the retrieval baseline blames for degrading the local model. `GET /v1/config` therefore
reports the unembedded count, so the cost of resuming is visible before it is paid rather than
arriving as a fan spinning up.

Reflection answers with degraded retrieval while embeddings are off: `similar_entries` is absent, so
it searches with the word-based tool alone and silently misses semantically-related Entries. Nothing
in the Answer says so, which is why the Settings surface says it instead.

Every fixture that constructs the Reflection state now carries a flags field, which is a wide but
purely mechanical change across the Server's test suite.
