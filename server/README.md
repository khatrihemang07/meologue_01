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

## Endpoint

`POST /v1/sync` — see `docs/adr/0002-*` and `docs/adr/0004-*` for the design.

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
