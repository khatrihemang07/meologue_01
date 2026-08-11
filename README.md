# meologue

A personal log. Type a thought, press Send, and it shows up on your other devices.

Local-first: writes land locally first and sync in the background, so the app stays usable
when the server doesn't. Self-hosted — a single Rust binary and a Postgres container.

## Run it

Needs Node 20+, pnpm, Rust, and Docker.

```bash
pnpm install
docker compose up -d          # Postgres on :5432

cd server && cargo run        # API on :41207, migrations apply on boot
pnpm dev                      # app on :5173, proxying /v1 to the server
```

Two processes in dev. The client only ever uses relative URLs, so it never needs to know
the server's address — Vite proxies `/v1` during development, and in production the server
serves the app itself:

```bash
pnpm --filter @meologue/web build
cd server && cargo run        # app + API together on :41207
```

That single port is the one to open from another device. The server binds `0.0.0.0`, so a
phone on the same LAN or tailnet can reach it directly.

## Layout

```
apps/web       React 19, Vite, Tailwind v4, shadcn/ui
apps/e2e       Playwright, against the production serving path
packages/core  sync engine and domain types — no React, no DOM
server         Rust, Axum, sqlx, Postgres
```

`packages/core` is deliberately platform-agnostic: it's what the Android and macOS targets
will share verbatim. Anything environment-specific — timers, focus events, `fetch` — is
injected into it.

## Checks

```bash
pnpm test                                   # unit tests (core + web)
cargo test --manifest-path server/Cargo.toml
pnpm --filter @meologue/e2e test:e2e        # boots the real stack, drives a browser
pnpm lint
```

The TypeScript wire types are generated from the Rust server, which owns the contract:

```bash
pnpm --filter @meologue/core generate:wire-types
```

The generated output is committed, so a fresh checkout doesn't need a Rust toolchain.

## How sync works

One endpoint, `POST /v1/sync`, doing both directions in a single round trip: the client
sends anything unsynced along with its cursor, and gets back everything recorded after it.
Clients poll every few seconds while visible, and on focus and reconnect. No websockets.

Entries are **append-only and immutable** — no edit, no delete — so there are no conflicts
to resolve yet. Ordering for the cursor is a server-assigned sequence; display order is the
client's timestamp, because when you wrote a thought is what you'll care about later.

## Reading further

- `CONTEXT.md` — the glossary. Use these words; the code does.
- `docs/adr/` — why things are the way they are, including the two decisions most likely to
  surprise you: there is no authentication (trust is network-level), and the sync insert
  takes an advisory lock on purpose.

## Not built yet

SQLite and full-text search (the local store is browser-local for now, behind the interface
that SQLite will implement), offline PWA, Android, macOS, editing, conflict copies, export.
