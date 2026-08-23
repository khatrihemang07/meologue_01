# 0029: Testing runs in a Sandbox instance that shares only the working tree

## Status

Accepted. Relaxes ADR 0011's e2e harness arrangement — the second Server's independence is now a
second database rather than a second Postgres container. What the multi-server spec proves is
unchanged.

## Context

Every kind of testing this repo does has, until now, run against the same Postgres, the same
Server port, the same `dist/` directory and the same app identifiers a developer uses for their
own Entries. Nothing separated the two but care, and care kept failing:

- The database on `:5432` held the test corpus, a stray `meologue_native` database of pure
  verification junk (`macundo test`, six empty bodies), an orphaned `_sqlx_test_*` database left
  by `cargo test`, and two e2e Entries that had leaked into the corpus itself.
- `scripts/e2e.sh` existed only to work around this. It renamed the live database aside, handed
  the suite an empty one, and restored it through a `trap` on every exit path. Its own header
  recorded why: pollution "has happened, and had to be cleaned up by hand." It also refused to
  start while anything held a connection, so running the suite meant stopping the dev server.
- An e2e run rebuilt `dist/web` — the bundle the developer's own Server serves — from whatever
  state the working tree happened to be in.
- `adb install -r` and a Tauri build replaced the installed apps, because both shells carried a
  single identifier.

Each of these was patched individually as it was noticed. The pattern underneath them is that the
two uses were distinguished by convention at every layer and by construction at none, so every new
feature added one more place for the convention to be forgotten. Digest was the clearest case: its
spec writes `digests` rows through `docker exec ... psql`, and the only thing that kept those rows
out of the corpus was a wrapper script that a developer had to remember to use.

## Decision

Two instances that share the working tree and nothing else.

| | Production | Sandbox |
|---|---|---|
| Postgres | `meologue-postgres`, `:5432`, volume `meologue-pgdata` | `meologue-postgres-sandbox`, `:5442`, volume `meologue-pgdata-sandbox` |
| Server | `:41207` (`cd server && cargo run`) | `:41307` (`scripts/sandbox-server.sh`) |
| Web bundle | `dist/web` | `dist/sandbox` |
| Service worker | yes | no |
| Android | `com.meologue.app` | `com.meologue.app.sandbox` |
| macOS | `meologue.app` / `com.meologue.app` | `meologue-sandbox.app` / `com.meologue.app.sandbox` |

The separation is load-bearing at each layer rather than conventional:

- **Two Postgres containers, not two databases in one.** A database name is one `DROP` away from
  the wrong target and one `docker compose down -v` away from irrelevant. A separate container
  with a separate volume means the destructive commands testing is most likely to reach for
  cannot address the production instance at all.
- **Two Server ports give two browser origins for free.** Both `meologue.server-url`
  (`apps/web/src/lib/settings.ts`) and the OPFS SQLite store are origin-keyed, so the web clients
  separate with no client code change whatsoever. This is the cheapest part of the split and the
  one that does the most work.
- **Two bundle directories.** `dist/web` changes only when the developer builds it. Nothing a test
  runs can swap out the app their Server is serving.
- **Two package identifiers.** An APK and a `.app` are frozen artifacts, so rebuilding
  `dist/android` is harmless on its own — only installing the *same* identifier replaces an
  installed app, which the `.sandbox` suffix prevents. Android uses a `sandbox` build type
  (`initWith debug`, `applicationIdSuffix ".sandbox"`) rather than a product flavor, because a
  flavor would rename `assembleDebug` to `assembleProductionDebug` and break every documented
  command. macOS uses a `--config` patch, `apps/macos/tauri.sandbox.conf.json`.

  **The native Sandboxes carry their own platform's bundle, not `dist/sandbox`.** The identifier
  suffix is the entire isolation mechanism, and it is enough: `com.meologue.app.sandbox` gets its
  own `~/Library/Application Support` directory and its own Android data directory, so the two
  installs share no state whatever bundle they hold. Pointing the Mac Sandbox's `frontendDist` at
  `dist/sandbox` looked tidier and was wrong — `sqlite-driver.sandbox.ts` re-exports the *web*
  driver, so the Sandbox `.app` ran OPFS inside the WebView and never touched
  `TauriSqliteDriver`. A Sandbox that doesn't exercise the platform seam it exists to test is
  worse than no Sandbox, because it reports success for code that never ran. `dist/sandbox` is
  for the web Sandbox on `:41307` and nothing else.

### The build target is named `sandbox`, never `test`

`apps/web/vite.config.ts` resolves `BUILD_TARGETS` off Vite's `mode`, and vitest runs with
`mode === "test"`. Adding `"test"` to that array would repoint every `@/platform/*` alias during
unit tests, to files that don't exist. The name is a constraint, not a preference.

### The Sandbox bundle has no service worker

`vite.config.ts` gates VitePWA on `target === "web"`, and the Sandbox is deliberately not that
target. This is a feature, not a side effect: a stale service-worker cache serves an old shell
after a rebuild, which is indistinguishable from a broken build and has cost real debugging time.
The instance whose whole purpose is rebuilding constantly is the one that should not have one.

### The e2e suite moves onto the Sandbox, as two databases in one cluster

`scripts/e2e.sh` no longer parks and restores anything. It drops and recreates `meologue_e2e_a`
and `meologue_e2e_b` empty inside the Sandbox Postgres, then runs Playwright. The trap, the
connection check and the `meologue_corpus_backup` name are all gone, along with the third
container the old arrangement needed.

This relaxes what ADR 0011's harness set up. That decision gave server B its own container, its
own port and its own volume, on the grounds that a shared database would defeat a spec proving
Entries stay routed by Server URL alone. The requirement it actually stated — the two Servers
share no database — is satisfied by two databases in one cluster. The extra container was buying
isolation from something that was never under test.

One e2e server keeps building the `web` target: `pwa.spec.ts` cuts the network and asserts History
still renders, which only holds with a service worker. It builds into `dist/e2e` via an `--outDir`
override, so it exercises the real shipping target without overwriting `dist/web`.

### The Sandbox database is seeded, and the old corpus is dropped

`scripts/seed-sandbox.sh` fills the Sandbox with roughly 120 Entries of ordinary modern journal
writing across the last two months, dated *relative to seed time* rather than pinned, so Digest's
calendar Periods always have material however long the corpus sits there. Recurring threads run
through it so Reflection retrieval has something real to find.

The 484-Entry Barbellion corpus that preceded it is retired.

## Consequences

**The cost, stated plainly: retrieval is now measured against a much smaller corpus.** ADR 0023
records that `MIN_SIMILARITY = 0.60` separated present from absent topics at roughly 80 Entries
and does *not* at 572 — that is the whole reason the large corpus was built. A ~120-Entry Sandbox
sits at the small end of that range, so retrieval will look better here than it is. Any future
tuning of `MIN_SIMILARITY` or the fan-out in ADR 0023 measured only against the Sandbox will be
measuring the wrong thing, and needs a corpus built for the purpose first.

`cargo test` should be pointed at `:5442`, because `#[sqlx::test]` provisions its throwaway
databases inside whatever instance `DATABASE_URL` names, and an interrupted run leaves them
behind — which is exactly how the orphaned `_sqlx_test_*` database above came to sit next to a
developer's Entries.

The Sandbox Server inherits the developer's `server/.env` for `MEOLOGUE_CHAT_*`, `MEOLOGUE_EMBED_*`
and `MEOLOGUE_TZ`. That is deliberate — those name stateless endpoints, and duplicating them would
mean two files to keep in step. `scripts/sandbox-server.sh` sets `DATABASE_URL`, `STATIC_DIR` and
`PORT` as plain assignments rather than `${VAR:-default}` fallbacks, so an exported variable from a
shell that had been working on the production instance cannot redirect it; dotenvy does not override
variables already in the environment, so those exports still win over `.env`.

Nothing about the production workflow changes. `docker compose up -d` still starts one container —
the Sandbox service sits behind a `sandbox` profile, and the scripts that need it name it
explicitly, which Compose honours regardless of profile.

**The profile is not a safety boundary, and one command in particular is a trap.** A Compose
profile *widens* the set of services a command applies to; it never narrows it. So
`docker compose --profile sandbox down -v` removes `meologue-pgdata` along with the Sandbox's
volume — it destroys the production instance. Resetting the Sandbox means naming the service:
`docker compose down -v postgres-sandbox`. This is written down because it was discovered by
doing it, while building the very separation meant to prevent it: the container split stops a
command aimed *at the Sandbox* from reaching the production data, and does nothing about a command
that was quietly aimed at both.

The Server owns the schema, so a Sandbox on a freshly created volume has no tables until
`scripts/sandbox-server.sh` has run once. `scripts/seed-sandbox.sh` checks for `entries` and says
so rather than letting psql report a bare "relation does not exist".
