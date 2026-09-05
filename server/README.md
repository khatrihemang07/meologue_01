# meologue-server

The Rust server. Owns the wire contract (see `docs/adr/`).

## Running

```sh
docker compose up -d          # Postgres, from the repo root
pnpm --filter @meologue/web build   # from the repo root
cargo run                     # applies migrations, then serves the app on :41207
```

`DATABASE_URL` defaults to `postgres://meologue:meologue@localhost:5432/meologue`, matching
`docker-compose.yml`; override it to point elsewhere.

`STATIC_DIR` defaults to `../apps/web/dist/web` (i.e. the built web app, relative to this crate);
override it if you're running the binary from somewhere else. One process serves both the API
and the built app on one port — open that port's address from any device on the same network
(e.g. a phone) to get a working app; no separate web server or CORS configuration needed.

Those defaults describe the **production** instance. Testing runs the same binary against the
Sandbox instead (ADR 0029) — a separate Postgres on `:5442`, `dist/sandbox`, port `41307` — which
`scripts/sandbox-server.sh` sets up. Nothing below distinguishes the two: it is the same server,
and every command here works against either once `DATABASE_URL` says which. Run that script before
`scripts/seed-sandbox.sh` on a fresh Sandbox — this server applies the migrations the seed needs.

Android and macOS Sandbox shells install alongside the production ones as `com.meologue.app.sandbox`:
`./gradlew assembleSandbox`, and `cargo tauri build --config tauri.sandbox.conf.json`.

`server/.env` is read at startup, and does not override variables already in the environment
(`src/main.rs`). That is what lets the Sandbox and e2e scripts pin `DATABASE_URL`, `STATIC_DIR`
and `PORT` while still inheriting whatever LLM configuration you keep in `.env`.

## Reflection: chat and embedding configuration

Both are off by default — see `docs/adr/0021-*` and `docs/adr/0022-*`. Nothing here is required
to run the server; every variable below is optional, and an unset one means the corresponding
feature stays off.

These can also be set via a `.env` file in this directory — copy `.env.example` to `.env` and
fill it in. It's loaded automatically on startup; an explicit environment variable always takes
precedence over `.env`.

| Var | Behaviour |
|---|---|
| `MEOLOGUE_CHAT_BASE_URL` | Base URL of an OpenAI-compatible `/chat/completions` endpoint. Unset → Reflection's chat step is off (unused before ticket 4). |
| `MEOLOGUE_CHAT_MODEL` | Model name sent in the chat request body. Unset → Reflection's chat step is off. |
| `MEOLOGUE_CHAT_API_KEY` | Optional bearer token, sent only when set. |
| `MEOLOGUE_EMBED_BASE_URL` | Base URL of an OpenAI-compatible `/embeddings` endpoint. Falls back to `MEOLOGUE_CHAT_BASE_URL` when unset, so one local endpoint can serve both without being configured twice. |
| `MEOLOGUE_EMBED_MODEL` | Model name sent in the embedding request body. Unset → the background embedding worker never starts. |
| `MEOLOGUE_EMBED_API_KEY` | Optional bearer token, sent only when set. |
| `MEOLOGUE_TZ` | An IANA zone name (e.g. `Asia/Kolkata`). Defaults to UTC when unset, empty, or unparseable (an unparseable value logs a warning rather than refusing to start). Decides which local day, ISO week (Monday start) or calendar month an Entry belongs to when the background Digest worker buckets it — see `docs/adr/0027-*` and `src/period.rs`. |

When embedding config is present, the server spawns a background worker on startup that fills
`entries.embedding` for every Entry, off the request path — `/v1/sync` never calls an LLM. See
`docs/adr/0022-*` for the queue design, and `src/embedding.rs` for the implementation. A quick
health check while the worker is running:

```sh
docker exec meologue-postgres psql -U meologue -d meologue -c \
  "select count(*) from entries where embedding is null"
```

That names the production instance's container; for the Sandbox it is
`meologue-postgres-sandbox`. Both answer to the database name `meologue`, so the container name is
the only thing that distinguishes them — worth reading twice before running anything destructive.

That count should trend to zero shortly after startup and stay there; a sustained non-zero count
either means embedding config is off (expected) or some Entries have hit the worker's retry cap.

Embeddings are expected to stay on a local, tailnet-only model (e.g. Ollama) — see ADR 0021 for
why pointing `MEOLOGUE_CHAT_BASE_URL` at a hosted provider is the one config choice that sends
Entry text outside the tailnet, and why that's deliberate rather than accidental.

## Server settings: a stored overlay on the environment

Since issue #200, the six `MEOLOGUE_CHAT_*`/`MEOLOGUE_EMBED_*` variables above and `MEOLOGUE_TZ`
are no longer read-once-at-startup-and-fixed. A Server also holds a settings row of its own in
Postgres, readable and writable over `GET`/`PATCH /v1/config`, and **a stored value wins over the
environment; the environment only seeds a field nothing has been stored for.** Clearing a field
(a `PATCH` with an empty string) means "fall back to the environment," not "off" — see
`docs/adr/0060-*` for why this deliberately departs from ADR 0011/0021's "empty means off," and
`src/settings.rs::resolve` for the precedence itself, a pure function with its own unit tests.

Two more variables arrive with this:

| Var | Behaviour |
|---|---|
| `MEOLOGUE_MODE` | `production` or `sandbox`, defaulting to `production`. Names this instance — in its startup banner today, in a UI banner or log prefix later — and decides nothing else: it does **not** affect precedence. See `docs/adr/0061-*`. |
| `MEOLOGUE_CONFIG_LOCK` | Any non-empty value makes this Server ignore its stored settings entirely and read only the environment, as if `server_settings` held nothing. Not something to copy into your own `.env` — the e2e scripts set it so the persistent e2e databases can't poison a suite run with a stored value left over from a previous one. |

`GET /v1/config` reports each field's resolved value **and where it came from** (`stored`, `env`,
or `unset`) — without the source, a UI can't tell a value it may Clear from one it can only
override. It also reports the instance's `mode`, whether it is `locked`, and
`unembedded_entries` (`select count(*) from entries where embedding is null and deleted_at is
null` — the same predicate the embedding worker's own scan uses, served by the
`entries_unembedded_active` partial index migration `0018` adds specifically to match it).
`PATCH /v1/config` accepts any subset of the seven overridable string fields; a field absent from
the body is left untouched, an empty string clears it back to `NULL`.

Both routes are registered unconditionally — a Server with no chat model, no embed model and no
Digest worker still answers `GET /v1/config`, because that endpoint is how such a Server becomes
configured in the first place.

**API keys come back in full on `GET /v1/config`, not write-only.** Per ADR 0003 this Server has
no authentication at all; a caller able to reach `/v1/config` to change a key can already read
that same key straight out of the process environment or `server/.env`. Withholding it here would
cost the ability to check what is actually configured and buy no real confidentiality.

## Endpoints

- `GET /v1/health` — a service marker and protocol version, so a Device can tell this is a
  meologue Server before trusting it with Entries. Never touches the database and never rejects
  on protocol version — see `docs/adr/0010-*`.
- `POST /v1/sync` — see `docs/adr/0002-*` and `docs/adr/0004-*` for the design.
- `GET`/`PATCH /v1/config` — this Server's own settings, layered over the environment. See
  "Server settings" above and `docs/adr/0060-*`.
- `GET /v1/metrics` — Prometheus-format request counts, latencies, statuses, and Sync-specific
  counters (Entries pushed/pulled, protocol mismatches). Unauthenticated, like the rest of `/v1`
  (ADR 0003) — nothing scrapes it yet, this is emit-now-scrape-later.

## Logs

`RUST_LOG` controls log verbosity (e.g. `RUST_LOG=info cargo run`). Every request produces a
structured span (method, path, status, latency); `/v1/sync`'s span also carries the requesting
Device's id, and a protocol-version mismatch logs a warning rather than failing silently.

## Serving the web app

Unknown paths fall back to `index.html` (the app shell), since the web app is a single-page
app — see `router` in `src/lib.rs`. `/v1/sync` always takes priority over static serving.

## Regenerating the OpenAPI spec / TypeScript types

The server is the source of truth for the wire contract (ADR 0004). After changing a
request/response type in `src/sync.rs`, regenerate the committed TypeScript types:

```sh
pnpm --filter @meologue/core generate:wire-types
```

`cargo run -- openapi` alone prints the OpenAPI spec to stdout without needing a database
connection.

## Testing

```sh
docker compose up -d --wait postgres-sandbox
export DATABASE_URL=postgres://meologue:meologue@localhost:5442/meologue
cargo test
```

`#[sqlx::test]` provisions an isolated database per test and applies `migrations/` to it — inside
whichever instance `DATABASE_URL` names. Point it at the Sandbox on `:5442`, not at your own
Postgres: an interrupted run leaves its `_sqlx_test_*` databases behind, and that is exactly how
one came to be sitting next to a developer's Entries (ADR 0029).
