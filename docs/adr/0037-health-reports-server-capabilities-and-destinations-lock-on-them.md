# 0037: Health reports Server capabilities, and Destinations lock on them

## Status

Accepted.

Extends [0010](0010-reachability-is-a-dedicated-health-endpoint.md)'s health response with an
optional `capabilities` object, computed from the same `LlmConfig` `main.rs` already reads to
decide which routes exist at all. 0010's own guarantees — no database touched, no rejection on
`protocol_version` — are untouched; this only adds a second field alongside it, one a Device is
free to ignore exactly as it already ignores any other field it doesn't recognise.

Extends [0036](0036-the-shell-is-a-chat-list-and-a-thread-is-a-chat-thread.md)'s
`chat-list.tsx`. The four rows, their order, and 0036's `<a href>`/`aria-current`/`<nav
aria-label="Chats">` accessibility contract are unchanged; the static `DESTINATIONS` array
becomes a derived `useDestinations()`, which is the only thing new about the component's shape.

Builds on issue #130, already landed on this branch: `LlmConfig::reflect_config()` now needs
chat alone, handing back `None` for the embed client rather than refusing to build at all. The
`reflect` capability below reads that exact relaxed gate — this is precisely the "changing twice"
issue #133 was blocked on #130 to avoid.

Supersedes nothing.

## Context

`GET /v1/health` answered with `{service, protocol_version}` and inspected no LLM configuration
at all (0010's own design — health was deliberately DB-free and, until now, config-free too). A
Server that could serve neither Reflection nor Digests — no chat model configured, or none of
Reflection's tools resolvable — still answered its health check exactly like a fully-configured
one, because health had nothing to say about that. Settings reported a bare "Reachable" for such
a Server, which was true and useless: reachable said nothing about whether asking a Question or
opening a Digest would actually work.

The chat list (0036) drew all four rows unconditionally, reading nothing. A reader with no Server
URL configured, or one pointed at a Server with no chat model, saw four identical-looking rows and
learned the truth only after opening one and typing into it.

Three states are in play, and they are not learnable the same way:

- **Unconfigured** — no Server URL. Known instantly, offline, for free (0011's own "unset Server
  URL means Sync is off").
- **Feature absent** — the Server answers, but has no model behind a given feature. Known only by
  asking it, and the answer is good until the Server's own configuration next changes, which is
  rare.
- **Unreachable** — a Server is configured but is not answering right now. Known only from a
  request that actually failed, and the answer is good for a moment, not a session.

A design that collapses these into one signal gets at least one of them wrong: probing before
every render makes Unconfigured cost a network round trip it doesn't need; treating Feature
absent as Unreachable makes Settings' own copy vague about what to actually fix; caching
Unreachable persistently makes a Device that comes back online report an outage that ended
hours ago.

`chat-list.tsx` also carries a hard constraint from [0008](0008-device-settings-are-local-configuration-outside-the-entry-store.md)
and [0009](0009-entry-store-and-sync-move-to-a-layout-route-above-history-and-composer.md): it has
to keep rendering, with no Entry-store read and no awaited network call, because it renders beside
`/settings` even when the Entry store fails to open — Settings is where a bad Server URL gets
fixed, and the list is what makes Settings reachable from a broken state. Whatever answers
"is this Destination locked" has to be readable synchronously, before this component's first
paint, or that guarantee breaks.

## Decision

**Health reports what the Server can actually serve, derived from the same configuration that
gates the routes.** `HealthResponse` gains `capabilities: Option<HealthCapabilities>` —
`{reflect, digest, embeddings}` (`server/src/health.rs`). `reflect` and `embeddings` read
`Option<ReflectState>`, and `digest` reads a new `DigestsEnabled` newtype, both pulled off
`AppState` through their own `FromRef` impls (`server/src/lib.rs`) the same way
`sync::sync_handler` and `reflect::reflect_handler` already read their own slice of it.
`router_with_digests` builds `AppState` from exactly the `reflect`/`digests_enabled` values
`main.rs` computed for route registration, so `health_handler` cannot read a different answer
than the routes themselves did — there is only one place either fact is computed. `embeddings`
reports `reflect.embed_client.is_some()`, per issue #130: a chat-only Server reports
`reflect: true, embeddings: false`, matching `reflect.rs`'s own tool loop, which simply omits
`similar_entries` in that configuration rather than refusing to answer. `health_handler` still
never touches `PgPool` — 0010's DB-free guarantee holds structurally, not by convention, because
the handler's extractors don't include it.

**The field is optional on the wire, and an absent one is unknown, not a mismatch.**
`capabilities` is `Option`, which utoipa marks `required: false` and `openapi-typescript` turns
into `capabilities?: ...` (`packages/core/src/generated/wire.ts`, regenerated via
`generate:wire-types`). `checkServer` (`packages/core/src/server-check.ts`) carries
`body.capabilities ?? undefined` through its `ok` variant, entirely independent of the
`protocol_version` check a few lines above it — an older Server that predates this field fails
neither check on account of the other. This is load-bearing: `server-check.test.ts` pins it
explicitly, because the two checks living in the same function is exactly how a future edit could
accidentally couple them.

**A synchronous, per-Device cache is the only thing the chat list is allowed to read.**
`apps/web/src/lib/settings.ts` gains a `capabilities: ServerCapabilities | null` field on the
existing Zustand store, persisted to `localStorage` under `meologue.capabilities` — one more key
in the established one-key-per-setting convention, read synchronously at module load exactly like
`serverUrl` already is. `refreshCapabilities()` re-probes `/v1/health` in the background: once
after this app's first paint (`main.tsx`, a double `requestAnimationFrame`, the same "a frame has
actually painted" trick `use-wide-layout.ts` uses), and again whenever a Server URL is saved in
Settings. Nothing awaits it. `chat-list.tsx`'s `useDestinations()` reads this cache and
`useSyncEnabled()` and nothing else — no Entry-store read, no network call — which is what keeps
0008/0009's guarantee intact.

**Unknown means unlocked, and a locked row is muted, never red.** `capabilities: null` — a fresh
install, a Server URL just changed, a refresh that hasn't landed yet — reads as "every feature
available," the same posture 0011 already takes for a missing Server URL turning Sync off rather
than erroring. Falsely locking a working Server tells the reader something untrue about their own
setup; a wasted tap that lands on a screen already written to explain itself (the existing
"Sync is off" / "this Server doesn't support … yet" prose on every Destination page) costs far
less. A locked row (`chat-list.tsx`) gets a lock glyph and `text-muted-foreground`, stays a real
`<a href>` via `NavLink` exactly as every row already was, and is never `text-destructive` — the
same neutral treatment CONTEXT.md's *Sync status* entry requires ("off is the default and reads
as a neutral state, not an error").

**Only Reflection and Digest can lock.** Both are written by the Server and neither exists on the
Device, so with no Server there is genuinely nothing to show. Composer is deliberately excluded
even though it sits beside them on the root screen: meologue is a local-first log, an Entry is
captured, searched, edited and Exported with no Server at all, and `composer-page.tsx` keeps its
thread and its input working with Sync off, showing only a note beside them. An earlier draft of
this decision locked Composer too, on the argument that the row was naming a fact about Sync
rather than a claim about Composer. That was rejected on two counts. A lock glyph is read as
"you cannot use this", and the other three rows use it to mean exactly that — one glyph cannot
carry both meanings in one list. And an unset Server URL is the *default* (ADR 0011), so it would
greet every fresh install with three locked rows, including the only Destination that works, which
is precisely the "neutral, not an error" reading CONTEXT.md asks for being thrown away at first
run. Reflection and Digest lock when Sync is off, and additionally when their own `capabilities`
key reads `false`. Settings never locks — it is the only way out of every other locked row.

**Unreachable is learned from a failed request, never probed, and it takes away only the write.**
`serverRequest` (`apps/web/src/lib/server-request.ts`) — the one function every transport
(Reflect, Digest, Sessions, Models) already funnels through — sets a new, deliberately
unpersisted `serverReachable` flag on the settings store: `true` on any real response, `false`
only on a thrown `fetch`. Reflection (`reflection-page.tsx`) reads it to drop `composerSlot`
while replacing what used to be an error toast with a persistent, neutral
`ServerUnreachableBanner` (`apps/web/src/components/server-unreachable-banner.tsx`) carrying a
Retry that calls `refreshCapabilities()`. Old Turns already in the session-fetch query cache are
untouched by a failed ask, so they stay on screen; Sessions themselves are a separate,
unaffected route (`SessionsLink`). Digest and its reader page (already read-only, no composer to
drop) show the same banner and additionally gate their own queries on `enabled: serverReachable`
— `digestTransport`/`digestAtTransport` never throw, so a failed background refetch is new
*data* to TanStack Query, not an error, and would otherwise silently overwrite an
already-successful Digest in cache with a failure marker the instant it resolved. Pausing
further fetches while known-unreachable is what keeps an already-loaded Digest "still readable"
rather than blanking out from under a reader mid-outage; Retry's `refreshCapabilities()` flipping
`serverReachable` back to `true` is what lets a previously-disabled query fetch again on its own.

**Settings names the gap instead of a verdict.** `describeServerCheck`
(`apps/web/src/pages/settings-page.tsx`) reads the same `capabilities` a successful check just
returned and, when either `reflect` or `digest` is `false`, names it — *"Reachable — but this
server has no Digest model configured"* — rather than a bare "Reachable." `capabilities ===
undefined` (an older Server) still reads as the old, plain "Reachable" message: Settings has no
gap to name when it has no report to read one from, the same unknown-means-unlocked posture the
chat list takes.

## Alternatives considered

**Probing health on every chat-list render.** Accurate, and rejected outright: it breaks the
no-awaited-network-call constraint 0008/0009 depend on, and it would put a loading state — a
spinner, or a flash of "unlocked" while the request is in flight — on the one screen that has to
render instantly beside a broken Entry store.

**Locking only on an unset Server URL.** Free and simple, and wrong the moment a Server is
configured but has no chat model behind it: that Server answers health checks fine, so a
capability-blind chat list would show Reflect and Digest as fully unlocked rows leading nowhere,
exactly the defect issue #133 exists to close.

**Pessimistic-unknown — locking a Destination until its capability is confirmed.** The mirror
image of the chosen default, and worse in the case that matters most: every cold launch, before
the background refresh lands, would show a working Server's Reflect and Digest rows as locked,
which reads as the app itself being broken rather than as caution. A false lock is a stronger,
more actionable-looking claim than a false unlock — a reader trusts a lock icon; they don't trust
an unlabelled row the same way — which is exactly why optimistic-unknown is the safer of the two
kinds of wrong.

## Consequences

A fresh install — no Server URL, which ADR 0011 makes the default — shows Reflection and Digest
locked and Composer and Settings open. That is the intended first run: the two Destinations that
have nothing to show without a Server say so, and the one that captures Entries is untouched.

The capability cache can be stale between the moment a Server's own configuration changes and the
next background refresh (boot, or the next Settings Save) — there is no push channel, and none is
added here. A reader who reconfigures the Server itself (not just its URL) sees the old answer
until the next refresh; this is the same staleness `capabilities: null`'s optimistic default
already accepts, just narrower.

`serverReachable` and `capabilities` are two independent axes, tracked by two different
mechanisms with two different lifetimes — one persisted and slow-changing, one in-memory and
expiring the instant a request succeeds again. A future reader debugging "why does this row still
look locked" has to know which of the two is stale, since fixing one does not touch the other.

`embeddings` is reported and unused: no Destination row reads it today, since Reflection now
needs chat alone (issue #130). It exists on the wire because health has to report the whole of
what `main.rs` can compute without drift, not only the subset the current UI happens to gate on —
a future feature that genuinely needs an embed client (or #134's own follow-up) has it to read
without a second wire change.

`chat-list.tsx`'s `useDestinations()` is now a real derivation with somewhere for a new filter to
live, which is the point: issue #134 adds one more condition to the same function rather than
inventing a second lock mechanism beside it.
