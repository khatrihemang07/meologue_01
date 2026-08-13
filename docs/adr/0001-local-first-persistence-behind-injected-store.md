# 0001: Local-first persistence sits behind an injected store interface

## Status

Accepted

## Context

Meologue is local-first: a Device must be able to capture an Entry and show History without
network access, and Sync is something that happens *to* already-persisted data, not a
precondition for using the app. The persistence layer therefore needs to exist and be
exercised by the rest of the codebase well before there's a real embedded database wired up,
and it needs to be swappable per-platform later (the web app and any future native client will
not want the same storage engine).

## Decision

Persistence is accessed everywhere else in the codebase through an injected store interface —
the rest of the application depends on the shape of "save an Entry, list Entries," not on any
particular storage engine. For now that interface is backed by a fake (in-memory) implementation.
A real embedded store is swapped in behind the same interface later, without the calling code
changing.

## Alternatives considered

- **Wire up a real embedded database now, before there's anything to store.** Rejected: it
  front-loads a platform-specific choice (and likely a different choice per platform) before any
  code exists that needs to make that trade-off, and blocks early development on a decision that
  doesn't need to be made yet.
- **Depend on a concrete storage engine directly from application code, add the interface later
  if a second implementation is ever needed.** Rejected: retrofitting an interface after callers
  already assume a concrete engine's semantics tends to leak those semantics into the interface
  shape. Starting behind the interface keeps the boundary honest from day one.

## Consequences

Every later ticket that touches persistence talks to the store interface, not to a database
directly. The fake implementation is expected to be replaced, not extended into a permanent
storage engine.

## Correction (2026-08-12)

The "Decision" section above says the interface is backed by a fake (in-memory) implementation.
That was true when this ADR was written; the store the web app actually ships,
`LocalEntryStore` (`apps/web/src/lib/local-entry-store.ts`), is backed by `localStorage` and
persists across reloads — browser-local, not in-memory. A separate in-memory fake,
`InMemoryEntryStore` (`packages/core/src/test-support/in-memory-entry-store.ts`), does exist, but
only as test support. Left uncorrected in place rather than rewritten, per this repo's convention
of flagging drift instead of silently editing history.

## Correction (2026-08-13)

`LocalEntryStore` and its browser-local Device id, described in the correction above, no longer
exist (ticket 24). All three platforms now open the SQLite store behind the same injected
`EntryStore` interface this ADR established; `localStorage` appears nowhere in the app.
