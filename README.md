# meologue

A personal, local-first log for capturing short pieces of text on any Device and keeping them in
Sync across your Devices.

| Web | macOS | Android |
| --- | --- | --- |
| <img src="docs/screenshot-web.png" alt="The meologue web app, with the Composer above recent Entries" width="440"> | <img src="docs/screenshot-macos.png" alt="meologue in a native macOS window, showing the Composer and History" width="320"> | <img src="docs/screenshot-android.png" alt="meologue on Android, showing the Composer and History" width="150"> |

Send plain-text Entries without choosing a title, folder, or tag. Each Device writes locally first,
so capture, Search, editing, removal, and Export keep working offline. Sync is opt-in and catches up
in the background when a Server is configured. Optional Server features add Reflection over your
History and daily, weekly, and monthly Digests.

## Run it

Requires Node 22+, pnpm, Rust, and Docker. Install dependencies from the repository root:

```bash
pnpm install
```

meologue has two isolated instances, and one script per job for each:

| | Production | Sandbox |
| --- | --- | --- |
| Purpose | Your Entries | Testing and seeded data |
| Postgres | `meologue-postgres` on `:5432` | `meologue-postgres-sandbox` on `:5442` |
| Server | `:41207` | `:41307` |
| Web | Server on `:41207` | Vite on `:5174` |
| Run it | `./scripts/run-production.sh` | `./scripts/run-sandbox.sh` |
| Build an APK | `./scripts/build-android-production.sh` | `./scripts/build-android-sandbox.sh` |
| Build a `.app` | `./scripts/build-macos-production.sh` | `./scripts/build-macos-sandbox.sh` |
| Artifacts land in | `build/production/` | `build/sandbox/` |

Each one is the whole job: it checks its prerequisites, starts or builds everything it needs, and
reports what it produced. `./scripts/run-production.sh` builds and serves Production from one
process on the Server port above. Set that same address as the Server URL in Settings — an unset
Server URL means Sync is off, even when the Server serves the app.

Both instances can run at once; they share the working tree and nothing else. Seed the Sandbox with
`./scripts/seed-sandbox.sh`, in another terminal once its Server has applied migrations.

The checks warn rather than fail when a local model endpoint is configured but not running, which
is otherwise invisible until a Reflection call returns connection-refused. Pass `-h` to any script
for its own flags.

Use `docker compose stop` for an everyday stop; it preserves the production container and data. To
wipe only the Sandbox, run `docker compose down -v postgres-sandbox`. Do not substitute
`docker compose --profile sandbox down -v`: the profile widens the command to include the production
volume.

Reflection and Digest are off until an OpenAI-compatible chat endpoint is configured; Reflection
also needs an embedding endpoint. See [the Server configuration](server/README.md#reflection-chat-and-embedding-configuration)
for variables and timezone behavior.

Configuring an endpoint only points at it — for a local model (e.g. Ollama) it must also be
running, or Reflection fails with a connection-refused error. Start it with
`brew services start ollama` (or `ollama serve`) before using Reflection.

### Web

`./scripts/run-production.sh` is a frozen, production-style process: it builds the bundle and the
release binary, then serves both from one process on the Server port — Production holds real
Entries, so nothing there watches the working tree. The first `cargo build --release` takes
minutes; later runs, and `--no-build`, are near-instant.

`./scripts/run-sandbox.sh` stays the hot-reload path: it starts the API and a Vite server that
proxies `/v1` to it, so the Vite port is the Server URL there, and only there.
`./scripts/sandbox-server.sh` remains its single-process alternative.

Production's web app therefore moved off the Vite port onto the Server port. `localStorage` and
the OPFS SQLite store are keyed to the origin, so the new address starts empty with an unset Server
URL — set it and History fills back in from Sync. The frozen bundle is a real PWA build, so it now
has a service worker Vite's dev server never did; it updates with a prompt rather than a silent
reload, so it won't interrupt a half-typed Entry.

Browsers require a secure context for meologue's OPFS-backed SQLite store. `localhost` qualifies,
but another Device needs HTTPS. One tailnet-only option is:

```bash
tailscale serve --bg http://127.0.0.1:41207
```

Open the HTTPS name printed by `tailscale serve status`. Use Tailscale Serve, not Funnel: the Server
has no application-level authentication. The web app is installable and remains usable offline.

### Android

Requires the Android SDK command-line tools and a JDK 21. Android Studio and an emulator are not
needed. The SDK path comes from `apps/android/local.properties` or `ANDROID_HOME`, and Gradle uses
the `java` on `PATH` when `JAVA_HOME` is unset. `adb` is needed only to install the result.

The build scripts run the web build, `cap sync`, and Gradle in one step, and print the APK path:

| Variant | Script | Application ID |
| --- | --- | --- |
| Release | `./scripts/build-android-production.sh` | `com.meologue.app` |
| Sandbox | `./scripts/build-android-sandbox.sh` | `com.meologue.app.sandbox` |

Each script copies its APK into `build/production/` or `build/sandbox/`, renaming Gradle's
build-type-derived `app-release.apk` to `meologue.apk` on the way. `build/` is generated and
gitignored.

A debug build stays a manual `./gradlew assembleDebug` in `apps/android`. Run
`./scripts/setup-signing.sh` from the repository root before the first release build; the Sandbox
uses the debug key and needs no setup. Debug and release use different keys, so uninstall
`com.meologue.app` before switching between them; the Sandbox installs alongside either one. Both
can run and sync at once, each reaching only its own Server.

To reach a local Server over USB:

```bash
adb reverse tcp:41207 tcp:41207
adb reverse tcp:41307 tcp:41307       # Sandbox
```

Use `http://127.0.0.1:41207` or `http://127.0.0.1:41307` in Settings. Do not use `localhost`:
Capacitor intercepts that hostname. A tailnet URL is preferable when the Device must stay connected
away from USB or the current LAN.

### macOS

The native shell uses Tauri v2. macOS Command Line Tools are sufficient; install its CLI with
`cargo install tauri-cli --version "^2"`.

| Variant | Script | Bundle |
| --- | --- | --- |
| Release | `./scripts/build-macos-production.sh` | `meologue.app`, `com.meologue.app` |
| Sandbox | `./scripts/build-macos-sandbox.sh` | `meologue-sandbox.app`, `com.meologue.app.sandbox` |

A debug build stays a manual `cargo tauri build --debug` in `apps/macos`, with
`--config tauri.sandbox.conf.json` for the Sandbox. Run `./scripts/setup-signing.sh` from the
repository root before a release build. It creates a local, self-signed identity; builds are signed
but not notarized, so another Mac requires one explicit right-click → Open. Production and Sandbox
bundles have separate identifiers and application data. Both can run and sync at once, each reaching
only its own Server.

The `.app` and its `.dmg` are copied into `build/production/` or `build/sandbox/`, keeping their
real bundle names — renaming the Sandbox to `meologue.app` would put two indistinguishable entries
in the Dock.

They also sidestep a Tauri quirk worth knowing if you build by hand: it clears
`target/release/bundle/dmg/` on every run, so there only the most recently built variant's disk
image survives, and the build that removes the other reports nothing but its own success. The
copies keep both; a manual `cargo tauri build` still loses one.

## Layout

```text
apps/web       React, Vite, and Tailwind UI shared by every platform
apps/android   Capacitor Android shell
apps/macos     Tauri macOS shell
apps/e2e       Playwright tests against the production serving path
packages/core  domain types, local persistence, and Sync engine
server         Rust, Axum, sqlx, and Postgres
scripts        one script per job per instance, plus shared lib/ helpers
build          generated: the .apk, .app, and .dmg each build script collects
```

There is one Vite application, selected for each platform with a build mode. Environment-specific
storage and lifecycle behavior live behind `apps/web/src/platform/`; `packages/core` stays
platform-agnostic.

## How Sync works

`POST /v1/sync` sends pending local changes and pulls everything after the Device's Cursor in one
round trip. New Entries, edits, and removals travel as complete resulting states, not deltas. The
Server keeps a compacted change log and assigns a new sequence whenever an Entry changes, making the
change visible above every existing Cursor. A removal travels as a terminal tombstone.

Devices poll while visible and after focus or reconnect. History is ordered by the Entry's capture
time, which editing never changes. Concurrent offline edits use last-writer-wins by Server arrival;
meologue does not create conflict copies. See
[ADR 0002](docs/adr/0002-sync-cursor-server-assigned-sequence-advisory-lock.md) and
[ADR 0028](docs/adr/0028-entries-are-mutable-sync-carries-a-compacted-change-log.md) for the full
design.

## Checks

```bash
pnpm test
pnpm lint
./scripts/e2e.sh

export DATABASE_URL=postgres://meologue:meologue@localhost:5442/meologue
cargo test --manifest-path server/Cargo.toml
```

Tests use the Sandbox Postgres, never the production database. Stop a running Sandbox Server before a
full end-to-end run if its Reflection and Digest workers cause timeouts.

One server test currently fails on `main`, so `cargo test` is not green:
`a_chat_client_that_always_fails_stops_after_exactly_max_attempts` in `server/tests/digest.rs`
sees exactly twice `MAX_ATTEMPTS` calls. It is not a flake — it fails with `--test-threads=1`
too. Noted here so it is not mistaken for damage from whatever you are working on.

After changing Rust wire types, regenerate the committed TypeScript contract with:

```bash
pnpm --filter @meologue/core generate:wire-types
```

## Reading further

- [`CONTEXT.md`](CONTEXT.md) defines the domain vocabulary used throughout the codebase.
- [`docs/adr/`](docs/adr/) records architectural decisions and their trade-offs.
- [`server/README.md`](server/README.md) covers Server configuration, endpoints, logs, and tests.

## Not built yet

Automatic conflict copies for concurrent offline edits.
