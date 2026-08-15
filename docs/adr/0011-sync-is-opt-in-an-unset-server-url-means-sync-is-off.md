# 0011: Sync is opt-in — an unset Server URL means Sync is off

## Status

Accepted. Supersedes ADR 0008's resolution-precedence clause (the build-time-constant, then
same-origin fallback chain) and finishes what ADR 0006 left open when it named opt-in Sync as
the intended end state. The rest of ADR 0008 — settings live in `localStorage`, outside the
Entry store, read per sync tick rather than cached at load — stands unchanged.

## Context

An unset Server URL has never meant one thing. It fell back to the build-time `VITE_SERVER_URL`
(ADR 0006) if that was set, and to same-origin — a relative `/v1/sync` — if it wasn't. On the web
build served by the Rust server, same-origin happened to be correct, so "nothing is configured"
and "it's working" were indistinguishable there. On the native shells, same-origin resolves to
the app's own custom scheme (`http://localhost` under Capacitor, `tauri://localhost` under
Tauri), where no Server has ever existed — so the same fallback that quietly worked on web
quietly failed on Android and macOS, request after request, with nothing to explain why.

ADR 0008 already named the destination in its Consequences: "The intended end state is Sync
being opt-in via this field, where empty means Sync is off rather than 'fall back.'" This ADR is
that ticket.

## Decision

**Empty means off, on every target, with no fallback behind it.** `readServerUrl()` in
`apps/web/src/lib/settings.ts` returns exactly what's stored, or the empty string — no build-time
constant to fall back to (`VITE_SERVER_URL` is deleted from `vite.config.ts`, from every build
script, and from the README), and no same-origin default behind that. The web build gets no
special case: it now needs a Server URL typed into Settings once, the same as every other target,
even though — unlike the native shells — same-origin would still have worked.

**The gate lives at the sync loop, not inside the transport.** `apps/web/src/hooks/use-history.ts`'s
`runSync` checks `readServerUrl() !== ""` before calling `sync()` at all — no store read, no
`fetch`, nothing for `syncTransport` to even attempt. `syncTransport` itself stays a thin POST to
`${readServerUrl()}/v1/sync`, unchanged in shape from ADR 0008, on the understanding that it's
only ever invoked once a Server URL exists. This mirrors ADR 0008's placement of the read: fresh
on every call rather than hoisted to module scope, so saving or clearing the address in Settings
takes effect on the very next tick, with no reload.

**`checkServer` (`packages/core/src/server-check.ts`) reports `{ ok: false, reason:
"not-configured" }` for an empty URL, before ever touching `fetch`.** It previously requested a
relative `/v1/health` for an empty URL, on the same same-origin assumption this ADR retires.
Settings now shows "No server configured — sync is off" on load and after clearing the field,
distinct from every other failure reason, and makes no network request to say so.

## Alternatives considered

- **Keep the same-origin fallback for the web target only, and only remove the build-time
  constant.** Rejected: this is the "one rule on all three targets" the ticket calls for — a
  web-only exception would mean "empty" still means two different things depending on which
  target a Device happens to be, which is the exact ambiguity this ADR exists to remove. It would
  also leave the e2e suite passing by accident rather than by an explicit Server URL, same as
  today.
- **Gate on the empty Server URL inside `syncTransport` (throw, or return early) rather than at
  the call site in `use-history.ts`.** Rejected: `sync()` in `packages/core` would still run its
  local `store.pending()`/`store.getCursor()` reads before finding out there's nothing to do, and
  a thrown error would route through `runSyncSilently`'s `console.error` every tick — a
  once-a-tick log line for a state that isn't actually an error. Gating before `sync()` is called
  means "no Server configured" produces no store activity and no console noise, matching "the app
  doesn't attempt and fail; it doesn't attempt at all."

## Consequences

A Device that has never had a Server URL typed into it does nothing on the network, ever — this
is now provable, not just intended, and the e2e suite proves it (see `apps/e2e/README.md`'s
two-Server harness, added alongside this ADR).

Every existing installed Device that relied on the same-origin or build-time-constant fallback
goes silent on upgrade until a Server URL is entered once. That is the point of the ticket, not a
regression: silence that used to mean "nothing configured, but it happened to work anyway" was
never something to preserve.
