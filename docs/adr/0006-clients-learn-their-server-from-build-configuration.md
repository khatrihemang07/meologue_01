# 0006: Clients learn their server from build configuration

## Status

Superseded by [0008](0008-device-settings-are-local-configuration-outside-the-entry-store.md)

## Context

The client has never needed to know its server's address. It only ever calls `/v1/sync`, a
relative URL, and that works because the web app is same-origin with its server — Vite proxies
the two together in dev, and the Rust binary serves both the app and the API from one port in
production (ticket 11). That property is documented in `vite.config.ts` and is also what has
kept CORS configuration off the server entirely.

A packaged Device has no such origin. Inside Capacitor the app runs at `http://localhost`;
inside Tauri, `tauri://localhost`. Neither is the server's origin, so a relative `/v1/sync`
there resolves to the app bundle, not to anything that answers it. The client needs to learn an
absolute server address from somewhere.

## Decision

The server address is a build-time constant, `VITE_SERVER_URL`, read via Vite's own env-var
mechanism and defaulting to empty. Empty reproduces today's relative URL exactly — `syncTransport`
prefixes every request with it, so an empty value and no prefix are byte-for-byte the same
request. The web build's behaviour is therefore unchanged; only a target built with the variable
set (a future Capacitor or Tauri build) would ever see a different URL.

Because a foreign origin can now issue real requests, the server gains a CORS layer
(`tower_http::cors::CorsLayer::permissive()`). Permissive rather than an allow-list of known
origins: ADR 0003 already extends full read/write trust to anything that can reach the server at
all, so restricting *which origins* the browser lets through gates nothing a reachable attacker
didn't already have without it.

Deliberately out of scope: any runtime or user-facing setting for the address. This is chosen
for simplicity now and is expected to be superseded once a packaging ticket needs the address to
be something other than a value baked in at build time (e.g. a server discovered or entered at
runtime).

## Alternatives considered

- **Have each packaged target hardcode its server URL directly in a per-target platform file**,
  following the ADR 0005 seam used for wake signals. Rejected: that seam exists for code that
  genuinely differs per platform (different APIs entirely). A server address is the same kind of
  value everywhere — a string — so one build-time variable with an empty default serves every
  target, web included, without a file per platform.
- **Restrict CORS to an allow-list of expected origins (`http://localhost`, `tauri://localhost`)
  instead of permissive.** Rejected: origin checks are a meaningful boundary only when the server
  distinguishes trusted callers from untrusted ones. ADR 0003 already declined to do that at the
  application layer, so an allow-list here would be a check that looks like a security boundary
  without being one.

## Consequences

Every current build (`build`, `build:web`, `build:android`, `build:macos`) leaves
`VITE_SERVER_URL` unset, so all of them keep issuing the same relative request as before this
ticket — the seam exists but nothing exercises it yet. A future packaging ticket sets the
variable for its build and, per the "Deliberately out of scope" note above, that ticket or a
later one still needs to decide how the value reaches a real Device outside of being baked in at
build time.
