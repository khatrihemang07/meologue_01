# 0004: The Rust server owns the wire contract

## Status

Accepted

## Context

The web app (and any future client) and the server need to agree on the shape of every request
and response that crosses the network between them. If that shape is defined independently on
each side, the two definitions drift the moment one side changes without the other — a class of
bug that only shows up at runtime, against a real server, often after it's already shipped.

## Decision

The request and response types are defined once, in the Rust server, and every other consumer
of the wire contract derives from that single definition rather than maintaining its own. The
server is the source of truth; clients are generated from it, not written by hand against it.

## Alternatives considered

- **Define the wire contract independently in each client, matching it to the server by
  convention and code review.** Rejected: this is exactly the drift scenario above — nothing
  stops the two definitions from silently diverging as either side changes.
- **Define the contract in a schema-first, language-agnostic format (e.g. a standalone schema
  file) and generate both the server's and the clients' types from it.** Rejected for v0.1: it
  adds a second source of truth (the schema file) that the server's own types must still be kept
  in sync with by hand, which reintroduces the drift problem one level up rather than removing
  it. Deriving directly from the server's types keeps there to be exactly one place the contract
  is authored.
- **Define the contract in the client and generate the server's types from it.** Rejected: the
  server is the component that actually enforces the contract at runtime (rejecting unrecognised
  protocol versions, deciding what's valid) — putting authorship on the client side would leave
  the component doing the enforcing without authority over what it's enforcing.

## Consequences

Any change to a request or response shape is made in the Rust server first. Generated client
types are committed to the repository so that a fresh checkout works without a Rust toolchain,
and regenerating them after a server-side change is part of making that change, not a separate
follow-up step.
