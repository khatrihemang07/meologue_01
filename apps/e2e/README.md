# @meologue/e2e

End-to-end coverage for ticket 11 ("History stays live across devices") and ticket 31 ("Sync is
opt-in"): independent browser contexts, standing in for independent Devices, syncing through real
Rust servers and real Postgres instances — nothing here is mocked.

## Running

```sh
pnpm --filter @meologue/e2e exec playwright install --with-deps chromium   # first time only
pnpm --filter @meologue/e2e test:e2e
```

Playwright's `webServer` (see `playwright.config.ts`) is an array of two independent Servers:

- **Server A** — `scripts/e2e-server.sh` starts Postgres via `docker compose`, builds the web
  app, and boots the server on `:41217`, serving both the app and `/v1/sync` — the same
  production serving path from `server/README.md`. Every spec's page loads from here.
- **Server B** — `scripts/e2e-server-b.sh` boots a second server on `:41227`, against a second,
  fully independent Postgres (`postgres-e2e-b` in `docker-compose.yml`, its own container and
  volume). It never serves the app, only `/v1/sync` and `/v1/health` — `multi-server.spec.ts` is
  the only spec that talks to it.

Docker must be running for either to start.

Sync is opt-in (ADR 0011): an unset Server URL means sync stays off, so every context needs one
seeded into `localStorage` before its first page load, or none of this suite's sync assertions
would ever be exercised. `tests/helpers.ts`'s `serverUrlStorageState` builds that seed;
`playwright.config.ts` applies it to the default `page` fixture (pointed at Server A), and
`openTwoDevices` applies it to each `BrowserContext` it opens — `multi-server.spec.ts` overrides
it per device to point at Server A and Server B respectively, proving a Device's Entries follow
its own Server URL setting rather than the origin that served its page.

This suite is intentionally kept out of `pnpm test` (see root `turbo.json`): it needs Docker, a
browser install, and takes far longer than the unit suites. Run it explicitly, e.g. before
opening a PR that touches sync, continuous-sync wiring, or the server's static serving.
