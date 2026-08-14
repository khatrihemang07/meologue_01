# 0010: Reachability is a dedicated health endpoint, not a trial sync

## Status

Accepted

## Context

A Device learns its Server's address from Settings (ADR 0008) as a plain string the user typed
or a build gave it. Before ticket 28, the only way to find out whether that address is actually
a meologue Server — as opposed to some other machine that happens to answer HTTP on that port, or
nothing at all — was to attempt a real `POST /v1/sync`. That conflates two questions that don't
share an answer: "is this a meologue Server?" and "does this Server accept the Entries I'm about
to send it?" `/v1/sync` also rejects with 426 the moment `protocol_version` doesn't match (ADR
0004), which is exactly the wrong behaviour for a reachability check — a client that doesn't yet
know what version the Server speaks has no correct value to send, and a version mismatch would
look identical to an unreachable or broken Server.

## Decision

`GET /v1/health` answers with a service marker and the protocol version the Server speaks,
`{"service": "meologue-server", "protocol_version": 1}`, so a Device can tell a meologue Server
apart from anything else answering that address and detect a protocol mismatch before any Entry
moves. It takes no request body — there is nothing for the caller to claim, and so nothing for
the endpoint to gate on. It never returns 426, unlike `/v1/sync`: its whole job is letting the
caller compare versions itself, and gating it would make a version mismatch indistinguishable
from a Server that's actually broken.

The handler touches nothing but its own two constants — no state extraction, no query. A Server
whose Postgres is down still answers `/v1/health` correctly, which is the property that makes it
useful as a reachability check in the first place: if it depended on the database, "the database
is unreachable" and "the Server is unreachable" would look the same to a Device.

Per ADR 0004, the response type (`HealthResponse`, in `server/src/health.rs`) is defined once in
the Rust server and regenerated into the OpenAPI document and the TypeScript wire types rather
than hand-written on the client.

## Alternatives considered

- **Keep probing with a trial `/v1/sync`, sending an empty entry list and reading whatever comes
  back.** Rejected: it can't distinguish "wrong protocol version" from "not a meologue Server" —
  both come back as errors indistinguishable to the caller — and it writes to (or at least
  touches) the database on every reachability check a Device makes, including ones that never
  intend to sync anything yet.
- **Have `/v1/health` also verify the database connection and report it in the response.**
  Rejected for this ticket: it would make "is this a meologue Server" depend on Postgres being up,
  which is precisely the coupling this endpoint exists to avoid. A Server whose database is down
  is still a Server a Device should be able to identify as such, even if syncing through it would
  currently fail.

## Consequences

A Device can now check reachability and protocol compatibility independently of whether it has
any Entries to sync, and independently of whether the Server's database is currently up. Nothing
in this ticket changes what a Device *does* with that information — wiring `/v1/health` into a
client-side reachability check is left to a later ticket.
