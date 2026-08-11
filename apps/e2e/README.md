# @meologue/e2e

End-to-end coverage for ticket 11 ("History stays live across devices"): two independent
browser contexts, standing in for two Devices, syncing through the real Rust server and a real
Postgres — nothing here is mocked.

## Running

```sh
pnpm --filter @meologue/e2e exec playwright install --with-deps chromium   # first time only
pnpm --filter @meologue/e2e test:e2e
```

Playwright's `webServer` (see `playwright.config.ts`) runs `scripts/e2e-server.sh`, which starts
Postgres via `docker compose`, builds the web app, and boots the server on `:8090` — the same
production serving path from `server/README.md`, exercised for real. Docker must be running.

This suite is intentionally kept out of `pnpm test` (see root `turbo.json`): it needs Docker, a
browser install, and takes far longer than the unit suites. Run it explicitly, e.g. before
opening a PR that touches sync, continuous-sync wiring, or the server's static serving.
