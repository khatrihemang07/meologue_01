# 0003: There is no authentication; trust is network-level

## Status

Accepted

## Context

Meologue is a personal tool: one user, syncing Entries between their own Devices. There is no
multi-tenant use case in scope — no sharing an account, no other users' Entries ever passing
through the same server.

## Decision

The server does not authenticate requests. A Device that can reach the server over the network
is trusted to sync with it. Reachability is expected to be constrained by the network itself —
a home LAN, or an overlay network such as Tailscale — rather than by anything the application
enforces.

## Alternatives considered

- **Add a login flow and per-user accounts now.** Rejected: there is no second user for an
  account system to distinguish from the first. It would add a real amount of surface area (
  credentials, sessions, recovery) in service of a requirement that doesn't exist yet.
- **Add a lightweight shared-secret or API-key check without full accounts.** Rejected for v0.1
  as unnecessary layered complexity on top of network-level trust: anyone who can reach the
  server can already reach it because the network let them, and a static secret shipped to every
  Device doesn't meaningfully change who that is.

## Consequences

The server must never be exposed to an untrusted network — deploying it reachable from the
open internet would hand out full read/write access to anyone who finds it. If a future ticket
introduces multiple users or exposure beyond a trusted network, this decision needs to be
revisited before that ships, not after.
