# meologue-server

The Rust server. Owns the wire contract (see `docs/adr/`).

## Running

```sh
docker compose up -d          # Postgres, from the repo root
cargo run                     # applies migrations, then serves on :8080
```

`DATABASE_URL` defaults to `postgres://meologue:meologue@localhost:5432/meologue`, matching
`docker-compose.yml`; override it to point elsewhere.

## Endpoint

`POST /v1/sync` — see `docs/adr/0002-*` and `docs/adr/0004-*` for the design.

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
