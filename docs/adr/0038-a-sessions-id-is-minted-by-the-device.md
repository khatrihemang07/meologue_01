# 0038: A Session's id is minted by the Device

## Status

Accepted. Extends [0033](0033-a-session-is-an-append-only-entry-tree.md)'s own "Amendment (issue
#108)," which moved *when* the `sessions` row is written — synchronously, in `resolve_session`,
before the run it belongs to even starts, so `harness::run_log::RunLog`'s first record has a real
`session_id` to key against. That amendment left *who chooses the id* exactly as
[0025](0025-sessions-are-held-by-the-server.md) first decided it: the Server, always. A request
naming no Session (`session_id: null`) minted one server-side; a request naming an id `resolve_session`
didn't recognise was a 404, never a create. This ADR changes who chooses the id, not when the row
appears — 0033's amendment, and everything else it and 0025 decided about a Session being an
append-only entry tree the Server alone holds, stands unchanged and is still load-bearing.
Supersedes nothing.

## Context

Issue #131's report: ask a Question, then leave Reflection for another destination before the
Answer arrives. Three things went wrong at once. An error toast — *"Couldn't reach Reflection.
Check your Server and try again."* — appeared, although the Server was fine. Returning to Reflect
showed a new, empty Session, not the one just asked into. And the Session that had actually been
asked into was nonetheless in the Session list, complete, with its Answer.

Two independent defects produced this, both traceable to the same root: the Device only ever
learned a Session's identity from a successful response.

**The transport couldn't tell its own cancellation apart from a Server outage.**
`apps/web/src/pages/reflection-page.tsx` aborts the in-flight `/v1/reflect` request on unmount
(`activeAbortRef`'s own cleanup effect) — ordinary teardown, so navigating away mid-Answer doesn't
leave a connection, or a `setState`, hanging off a component that's gone. But
`apps/web/src/lib/reflect-transport.ts`'s stream-read loop caught the resulting `AbortError` only
to decide whether to skip a `console.error`; either way it returned `{ ok: false, reason:
"unreachable" }`, the exact value a genuinely dead Server produces. `server-request.ts` did the
same one layer down: `AbortError` and a real network failure both collapsed to a bare `null`. The
one fact `reflectTransport` actually had — *this call's own `signal` fired* — was thrown away at
the exact point it was known, so `reflection-page.tsx`'s failure branch (`toast.error("Couldn't
reach Reflection...")`) fired for a cancellation the reader caused on purpose.

**The Server, not the Device, chose a fresh Session's id — and only handed it over on success.**
`server/src/reflect.rs`'s `resolve_session` mints the `sessions` row synchronously, before
`reflect_handler` ever commits to a 200 (0033's own amendment), and `run_reflect_stream` then runs
the loop detached, via `tokio::spawn` — the run keeps going even after the client disconnects. But
the *id* it minted only ever reached the Device inside the terminal `agent_end` frame
(`interpretAgentEnd`, `reflect-transport.ts`). Because an aborted ask reached the same failure
branch as a genuine one, `writeLastSessionId` (`last-session.ts`) and the `navigate('/reflect/<id>')`
call in `reflection-page.tsx`'s success branch both never ran. The Device forgot a Session the
Server was, at that exact moment, still busy finishing.

The two defects compound. Fixing only the first (a distinct abort reason, no toast) would still
leave a reader who left mid-Question with no way back to the Conversation the Server went on to
complete without them — the Session the report's third symptom described, sitting in the list,
reachable only by scrolling to find it.

## Decision

**The transport tells a deliberate abort apart from every other failure.** `ReflectResult`
(`reflect-transport.ts`) grows a fourth variant, `{ ok: false, reason: "aborted" }`, returned
wherever `signal?.aborted === true` explains why a `Response` never arrived — both in the
stream-read loop's own `catch` and in the earlier `response === null` branch, which shares the
same ambiguity one layer down at `serverRequest`. `reflection-page.tsx`'s failure branch treats
`"aborted"` as silent: no toast, no restored Question, nothing — there is nothing here worth
telling a reader who already knows they left. Every other reason (`"not-supported"`,
`"unreachable"`, `"agent-error"`) still reports exactly as it did before this ticket; a genuine
outage is still a genuine outage.

**The Device mints a Session's id before it ever asks, not after.** `reflection-page.tsx`'s
`handleAsk` generates a `crypto.randomUUID()` the first time a Conversation has no `sessionId` yet,
records it via `writeLastSessionId` and navigates to `/reflect/<id>` — both *before*
`reflectTransport` is ever called — then sends that id as `session_id` on the wire. This mirrors
how an Entry already works: CONTEXT.md's own Entry entry is explicit that "it is identified by an
id minted on the Device that created it," and `server/src/sync.rs`'s own upsert (`insert ... on
conflict (id) do update`) is what lets the Server accept whichever id a Device already chose,
rather than minting a competing one. A follow-up ask on an already-open Session mints nothing new;
`sessionId` from the URL already names it.

**A supplied id is upsert-shaped on the Server now, not resume-or-404.** `resolve_session`'s
`Some(id)` branch calls `sessions::find_session` first, exactly as before: a match resumes that
Session, loading its prior Turns. A miss no longer returns `ReflectError::SessionNotFound` (a 404)
— it calls the new `sessions::create_session_with_id`, which inserts under the Device's own id
(`on conflict (id) do nothing`, the same defensive idempotence `sync.rs`'s upsert uses, guarding
against nothing worse than a retried request racing itself). `derive_title` still runs
server-side either way; the Device sends only the id, never a title. The bare `session_id: null`
branch is untouched — a caller that never adopts this still gets a Server-minted id exactly as it
always has, and `ReflectRequest::session_id`'s own doc comment now says so.

**A known failure undoes the mint; a deliberate abort keeps it.** The two outcomes need opposite
treatment, and only one of them is knowable before the ask is dispatched. `"aborted"` means the run
might still be going on the Server — the whole reason for minting early — so its id, its URL and
its memory entry all stay. Every other failure (`"not-supported"`, `"unreachable"`, `"agent-error"`)
is a *known* dead end by the time `handleAsk` sees it: a 404/426 never reached `resolve_session` at
all, and an `agent-error` run only ever produced an empty, Turn-less row no client can see anyway
(0025's own guarantee, kept by `sessions::list_sessions`). `handleAsk`'s failure branch reverts —
`navigate("/reflect", { replace: true })`, and `last-session.ts` restored to whatever it held
before this ask — leaving a defeated ask exactly where a failed one always used to leave it, rather
than pointing a reader at a Session that will never exist.

**The Device's own read of a Session waits for its ask to settle.** Navigating to `/reflect/<id>`
before the Server has necessarily processed the matching `POST` opens a real race: the page's own
`sessionQuery` (`GET /v1/sessions/:id`) could reach the Server before `resolve_session` does,
404, and — if that response lands after `handleAsk`'s own optimistic `queryClient.setQueryData`
write — silently overwrite a just-answered Turn with "not found." `sessionQuery`'s `enabled` now
also requires `pending === null`: no session fetch runs while an ask for it is still in flight,
so by the time it does run, the ask has already settled and there is nothing left to race.

## Alternatives considered

**An early `session_start` SSE frame, ahead of the loop's first `step_start`.** Fits
[0034](0034-reflection-reports-its-progress-as-it-runs.md)'s own event vocabulary, and would let
the Device learn a Server-minted id sooner than `agent_end`. Rejected because it only shrinks the
race window, not closes it — the connection can still drop between the request being sent and that
first frame arriving, which is exactly the window issue #131 was reported from. The Device still
would not know the id *before* asking, so a leave-before-any-frame-arrives is unfixed.

**A response header carrying the Session id.** Available the instant headers go out, ahead of any
SSE frame at all. Rejected on two counts: this app is cross-origin (Device and Server on different
origins in the common case — a phone's browser against a laptop's Tailscale address), so reading a
custom header back needs `Access-Control-Expose-Headers` wired through every deployment; and it is
off-pattern for [0004](0004-rust-server-owns-the-wire-contract.md)'s JSON/SSE wire, which has never
put anything meaningful in a header the way this would ask it to.

**Holding the in-flight run alive in a store above the route, so a remount can reattach to it.**
Would let a reader leave and return mid-Answer without losing the live view, closer to the "no gap
at all" ideal. Rejected because it contradicts [0025](0025-sessions-are-held-by-the-server.md)'s
"the Device stores nothing at all" / URL-is-the-only-state posture that this whole ADR chain has
kept load-bearing — a store above the route is exactly the local mirror 0025 argued against — and
it dies on reload anyway, which a Device-minted id surviving in the URL and in `last-session.ts`
does not.

## Consequences

**A known gap, left deliberately open.** Returning to Reflection while the run is *still* in
flight — not yet aborted, not yet finished — shows the Question with no Answer until the next
refetch, because nothing exposes the `RecordKind::OperationStarted`/`tool_started`/`usage` records
`run_reflect_stream` already writes through `RunLog` (`server/src/reflect.rs`,
`harness/run_log.rs`) to any client. Closing that means a reattach route reading the operation log
0033's own amendment wired up but never exposed — filed separately, out of scope here.

**An orphaned Session row is now reachable under a Device-chosen id, not only a Server-chosen
one.** This was already true after 0033's amendment for a Server-minted id on a failed first ask;
it now also holds for a Device-minted one, on both a definite failure (briefly, until `handleAsk`'s
own revert clears the memory pointing at it — the row itself is never deleted, only forgotten) and
a genuine abort (indefinitely, by design — that row is the whole point). Neither changes the
guarantee 0025 and 0033 actually keep: `sessions::list_sessions` still requires at least one entry
before a Session is listed, so an empty row stays invisible either way.

**The wire contract's shape is unchanged; its meaning moved.** `ReflectRequest::session_id` was
already `Option<Uuid>` — every request already had a place to carry a Device-chosen id — so this
shipped with no schema change, only revised doc comments (`session_id`'s own, and the `/v1/reflect`
404 response's, which no longer mentions an unknown `session_id` at all). `packages/core/src/generated/wire.ts`
was regenerated to keep those descriptions in sync; nothing downstream had to change to read it.

**Two Devices minting for the same fresh ask can no longer collide the way two Server mints
never could either.** `crypto.randomUUID()`'s collision odds are the same ones every UUIDv4 already
carries throughout this codebase (Entry ids included) — not a new risk this ADR introduces, just
one more identity that now depends on it.
