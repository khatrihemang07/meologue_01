# 0060: Server settings are a stored overlay on the environment, and the UI wins

## Status

Accepted. Names [0008](0008-device-settings-are-local-configuration-outside-the-entry-store.md)'s
counterpart on the other end of Sync: 0008 gave a Device settings of its own, held entirely
client-side because they describe one installation and must never travel through Sync. This ADR
gives a Server the matching thing — settings that describe one process, held in the one database
that process already owns, reachable and changeable by any Device that talks to it. Extended by
[0061](0061-an-instance-names-itself-independently-of-whether-it-is-locked.md), which adds
`MEOLOGUE_MODE` on top of the mechanism this ADR builds and is explicit that naming an instance is
an unrelated fact to the lock this ADR also introduces.

## Context

Every Server setting — which chat and embedding endpoints Reflection and the background workers
call, and which timezone Digest buckets by — has lived in `server/.env` since ADR 0021/0027, read
once at process startup by `LlmConfig::from_env`/`period::server_timezone` and fixed for the
process's whole lifetime. Changing which model Reflection uses, or which timezone Digest buckets
by, has meant opening a terminal, editing a file, and restarting the process. That is a real cost
on a Server ADR 0003 already assumes runs unattended on a home network or a tailnet, reachable from
a phone that has no terminal on it at all.

The investigation behind this ticket started from a different complaint — a request to remove a
hard Ollama dependency — and found there wasn't one: `llm.rs`'s `LlmClient` trait already abstracts
any OpenAI-compatible endpoint, an unset config value already means the corresponding feature is
off (ADR 0021), and degradation is already graceful. What was actually missing was any way to
*change* that state without a terminal and a restart. This ADR is the foundation for that: a
Server-side store for the same values `.env` already holds, reachable over HTTP.

## Decision

**A single-row table, `server_settings`** (migration `0018_create_server_settings.sql`): one
nullable column per overridable field — the six `MEOLOGUE_CHAT_*`/`MEOLOGUE_EMBED_*` strings and
`MEOLOGUE_TZ` — plus three nullable booleans for the tri-state feature toggles
[0060](0060-a-feature-toggle-is-tri-state-and-idles-a-worker.md) gives behaviour to. `id` is pinned
to `1` by a check constraint, so a second row can never exist; every write is an upsert against
that same id (`settings::apply_patch`). The same migration adds `entries_unembedded_active`, a
partial index on `entries (id) where embedding is null and deleted_at is null` — the exact
predicate the embedding worker's own scan already uses (`embedding::select_unembedded`) — so that
scan and `GET /v1/config`'s "Entries not yet embedded" count are served by one index whose
condition matches their query exactly, not one that merely implies it.

**A stored value wins, and the environment seeds when nothing is stored — the opposite of ADR
0011/0021's "empty means off."** Clearing a field (a `PATCH` with an empty string, mirroring the
`.is_empty()` filter `LlmConfig::from_env`'s own `var()` helper already applies on read) means
"fall back to the environment," never "off." This is a deliberate departure, not an oversight, and
it is why the feature toggles [0060](0060-a-feature-toggle-is-tri-state-and-idles-a-worker.md)
introduces are tri-state rather than boolean: once "unset" means "defer to the environment," a
boolean can no longer express "off" on its own — `unset`, `on` and `off` have to stay three
distinct states.

**Precedence is a pure function, `settings::resolve`, unit-tested first.** It takes an already-built
`llm::LlmConfig`, an optional `MEOLOGUE_TZ` string, a `StoredSettings` row and a `locked` bool — all
as plain parameters — and returns one `ResolvedField { value, source }` per overridable field. It
reads no environment and touches no database, so its precedence rules (stored wins; clearing falls
back, not off; a locked Server ignores its row entirely) are provable with plain struct literals,
the same discipline `llm.rs`'s own `reflect_config` tests already use for exactly the reason stated
there: process environment is global, mutable state `cargo test`'s parallel threads would race
over. It deliberately does not call `LlmConfig::from_env()` itself — the caller (`main.rs`, and
`settings`'s own HTTP handlers) has already built one, and a second independent reader of the same
six variables inside `resolve` could drift from the first.

**`MEOLOGUE_CONFIG_LOCK` is enforced inside `resolve`, not at any of its call sites.** A locked
Server behaves, inside `resolve`, as though its settings row held nothing at all — every field
falls through to the environment (or to `Unset`) regardless of what is actually stored. Doing this
inside the one function every caller already goes through, rather than branching before calling it,
is what keeps what `GET /v1/config` reports as `locked`/read-only and what the Server actually runs
with from ever disagreeing: there is exactly one place this decision is made. The e2e scripts set
this (`scripts/e2e-server.sh`, `scripts/e2e-server-b.sh`) so the Postgres instance those Servers
share across a whole suite run can't have a stored settings row — written by an earlier spec, or by
a developer poking at the Server by hand — silently override the LLM stub configuration a later
spec depends on.

**`GET /v1/config`/`PATCH /v1/config` are registered unconditionally**, in the same
always-present block as `/v1/health`/`/v1/sync`/`/v1/metrics`, before the `/v1/{*rest}` catch-all —
not gated the way `/v1/reflect` or `/v1/digests/*` are. This is the one route that must exist on a
Server with nothing else configured, because it is the only way such a Server can *become*
configured. `GET` reports, per field, the resolved value and its `source`
(`stored`/`env`/`unset`) — without the source, a Device cannot tell a value it may Clear from one
it can only override with its own, and cannot honestly render a "(from environment)" hint next to
it. It also reports the instance's `mode`
([0061](0061-an-instance-names-itself-independently-of-whether-it-is-locked.md)), whether it is
`locked`, and `unembedded_entries`. `PATCH` treats a field absent from its JSON body as untouched
and an empty string as "clear to `NULL`"; `PORT`, `BIND`, `DATABASE_URL` and `STATIC_DIR` are
deliberately not part of the overridable set at all — a bad value written through this route would
make the UI that is supposed to fix it unreachable, and Settings is the recovery route this app
deliberately renders even when the Entry store itself fails to open (ADR 0008's own reasoning,
applied here to the Server side of the same problem).

**The stored-settings load sits below `main.rs`'s early return for `cargo run -- openapi`, not
above it**, and below the migration that creates `server_settings`. `openapi` prints the wire spec
and exits before a database pool is ever created; `wire-types` generation shells out to exactly
that command, so if it ever required a live Postgres, type generation would break for every
downstream ticket. The read this ADR adds costs nothing new in terms of failure modes beyond what
already exists — migrations already run at boot and already abort if Postgres is unreachable.

**API keys are returned in full on `GET /v1/config`, not write-only.** Per
[0003](0003-no-authentication-network-level-trust.md) this Server has no authentication at all, and
it already warns at startup that anything able to open a TCP connection to it can read and write
every Entry. A caller that can reach `/v1/config` to *change* `MEOLOGUE_CHAT_API_KEY` can already
read that same key straight out of the process environment or `server/.env` — withholding it here
buys no real confidentiality and costs the one thing this endpoint exists for: the ability to check
what is actually configured. Do not "fix" this by making key fields write-only; that would be
removing a capability to satisfy an intuition this ADR has already reasoned past.

## Alternatives considered

- **Environment always wins; a stored value is only a suggestion until the next restart.**
  Rejected: this is exactly today's status quo with extra steps — a Device could write a value that
  visibly does nothing until someone restarts the process from a terminal, which is the precise
  friction this ticket exists to remove.
- **A stored value and an environment value must match, or the Server refuses to start.**
  Rejected: this reintroduces a hard-failure mode for a mismatch that is often completely
  intentional (an operator deliberately overriding `.env` from a Device), and it would make every
  environment change a two-place edit instead of a one-place one.
- **Clearing a stored field means "off," matching ADR 0011/0021.** Rejected — see Decision. Once a
  Server holds a value the environment also holds, "off" and "not stored" stop being the same
  question, and this ADR's whole point is to let a Device answer only the second one. Keeping the
  ADR 0011/0021 meaning here would mean a Device could never get back to "whatever the environment
  says" without literally editing `.env` again — the exact terminal dependency this ticket removes
  everywhere else.
- **A dynamic, partial SQL `UPDATE` that only touches the columns a `PATCH` actually names.**
  Rejected in favour of read-merge-write (`settings::apply_patch`): the "absent means untouched"
  rule already has to be decided somewhere in Rust — there is no SQL value that means "leave this
  column alone" the way `NULL` means "set it to nothing" — so deciding it once, in Rust, against a
  `StoredSettings` already loaded, is simpler than half-building the same branch into a dynamically
  assembled `UPDATE` statement.
- **Withhold API keys from `GET /v1/config`, or return them masked.** Rejected — see Decision's
  final paragraph.

## Consequences

Every worker's startup config (`embed_worker_config`, `digest_worker_config`, `reflect_config`,
`resolve_context_window`) now reads off `settings::resolve`'s output rather than a raw
`LlmConfig::from_env()` — `main.rs` builds one `ResolvedSettings` once, right after migrations run,
and every downstream decision reads that. A future reader who wants to know "what will this Server
actually use for chat" has to read `settings::resolve`, not `llm::LlmConfig::from_env`, to get the
true answer once a settings row exists.

Changing which chat, embed or timezone value a *running* process uses still needs a restart for
this ADR alone — a stored value only takes effect the next time `main.rs` runs
`settings::resolve` at boot. [0060](0060-a-feature-toggle-is-tri-state-and-idles-a-worker.md)'s
follow-up gives the three feature toggles a way to take effect live, without a restart, by idling a
worker instead of touching route registration; the underlying chat/embed/timezone *values*
themselves stay restart-required, and `GET /v1/config` reports exactly that asymmetry per feature
rather than leaving a Device to guess it.

A `server_settings` row now persists across a Postgres restart the same as every other table — a
Server's settings survive exactly as durably as its Entries do, which is new: before this ADR,
losing `server/.env` meant losing configuration with no recovery beyond re-typing it, while an
Entry always lived in Postgres. This ADR gives configuration the same durability property Entries
already had.
