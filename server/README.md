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

## Reflection: chat and embedding configuration

Both are off by default — see `docs/adr/0021-*` and `docs/adr/0022-*`. Nothing here is required
to run the server; every variable below is optional, and an unset one means the corresponding
feature stays off.

| Var | Behaviour |
|---|---|
| `MEOLOGUE_CHAT_BASE_URL` | Base URL of an OpenAI-compatible `/chat/completions` endpoint. Unset → Reflection's chat step is off (unused before ticket 4). |
| `MEOLOGUE_CHAT_MODEL` | Model name sent in the chat request body. Unset → Reflection's chat step is off. |
| `MEOLOGUE_CHAT_API_KEY` | Optional bearer token, sent only when set. |
| `MEOLOGUE_EMBED_BASE_URL` | Base URL of an OpenAI-compatible `/embeddings` endpoint. Falls back to `MEOLOGUE_CHAT_BASE_URL` when unset, so one local endpoint can serve both without being configured twice. |
| `MEOLOGUE_EMBED_MODEL` | Model name sent in the embedding request body. Unset → the background embedding worker never starts. |
| `MEOLOGUE_EMBED_API_KEY` | Optional bearer token, sent only when set. |

When embedding config is present, the server spawns a background worker on startup that fills
`entries.embedding` for every Entry, off the request path — `/v1/sync` never calls an LLM. See
`docs/adr/0022-*` for the queue design, and `src/embedding.rs` for the implementation. A quick
health check while the worker is running:

```sh
docker exec meologue-postgres psql -U meologue -d meologue -c \
  "select count(*) from entries where embedding is null"
```

That count should trend to zero shortly after startup and stay there; a sustained non-zero count
either means embedding config is off (expected) or some Entries have hit the worker's retry cap.

Embeddings are expected to stay on a local, tailnet-only model (e.g. Ollama) — see ADR 0021 for
why pointing `MEOLOGUE_CHAT_BASE_URL` at a hosted provider is the one config choice that sends
Entry text outside the tailnet, and why that's deliberate rather than accidental.

## Endpoints

- `GET /v1/health` — a service marker and protocol version, so a Device can tell this is a
  meologue Server before trusting it with Entries. Never touches the database and never rejects
  on protocol version — see `docs/adr/0010-*`.
- `POST /v1/sync` — see `docs/adr/0002-*` and `docs/adr/0004-*` for the design.
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
docker compose up -d
export DATABASE_URL=postgres://meologue:meologue@localhost:5432/meologue
cargo test
```

`#[sqlx::test]` provisions an isolated database per test and applies `migrations/` to it.
