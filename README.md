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

meologue has two isolated instances:

| | Personal | Sandbox |
| --- | --- | --- |
| Purpose | Your Entries | Testing and seeded data |
| Postgres | `meologue-postgres` on `:5432` | `meologue-postgres-sandbox` on `:5442` |
| Server | `:41207` | `:41307` |

Start the personal app:

```bash
docker compose up -d
pnpm --filter @meologue/web build
cd server && cargo run
```

Open `http://localhost:41207`, then set that same address as the Server URL in Settings to enable
Sync. An unset Server URL means Sync is off, even when the Server serves the app.

For disposable testing, start and optionally seed the Sandbox instead:

```bash
./scripts/sandbox-server.sh
./scripts/seed-sandbox.sh       # run in another terminal after the Server is ready
```

Open `http://localhost:41307`. The Sandbox uses a separate database, bundle, port, and native app
identifier, so both instances can run together.

Use `docker compose stop` for an everyday stop; it preserves the personal container and data. To
wipe only the Sandbox, run `docker compose down -v postgres-sandbox`. Do not substitute
`docker compose --profile sandbox down -v`: the profile widens the command to include the personal
volume.

Reflection and Digest are off until an OpenAI-compatible chat endpoint is configured; Reflection
also needs an embedding endpoint. See [the Server configuration](server/README.md#reflection-chat-and-embedding-configuration)
for variables and timezone behavior.

### Web

For hot reload, run the API and Vite in separate terminals:

```bash
cd server && cargo run                  # terminal A
pnpm --filter @meologue/web dev         # terminal B, from the repository root
```

Use `http://localhost:5173` as the Server URL because Vite proxies `/v1` to the API. To develop
against the Sandbox instead, start `./scripts/sandbox-server.sh`, then run:

```bash
MEOLOGUE_PROXY_TARGET=http://localhost:41307 pnpm --filter @meologue/web dev
```

Only one Vite server can bind `:5173`, so running both hot-reload frontends at once means giving
the Sandbox Vite server a different port:

```bash
./scripts/sandbox-server.sh             # terminal C, from the repository root
MEOLOGUE_PROXY_TARGET=http://localhost:41307 \
  pnpm --filter @meologue/web dev --port 5174  # terminal D, from the repository root
```

Open `http://localhost:5173` for the personal instance and `http://localhost:5174` for the
Sandbox, using each as that instance's own Server URL. For a production-style build instead, use
the personal or Sandbox commands in the preceding section; the Rust process serves the app and API
together.

Browsers require a secure context for meologue's OPFS-backed SQLite store. `localhost` qualifies,
but another Device needs HTTPS. One tailnet-only option is:

```bash
tailscale serve --bg http://127.0.0.1:41207
```

Open the HTTPS name printed by `tailscale serve status`. Use Tailscale Serve, not Funnel: the Server
has no application-level authentication. The web app is installable and remains usable offline.

### Android

Requires the Android SDK command-line tools, a JDK, `ANDROID_HOME`, `JAVA_HOME`, and a connected
Device with adb; Android Studio and an emulator are not required.

```bash
pnpm --filter @meologue/web build:android
cd apps/web && npx cap sync android
cd ../android
```

| Variant | Command | Application ID |
| --- | --- | --- |
| Debug | `./gradlew assembleDebug` | `com.meologue.app` |
| Release | `./gradlew assembleRelease` | `com.meologue.app` |
| Sandbox | `./gradlew assembleSandbox` | `com.meologue.app.sandbox` |

Install an APK with `adb install -r <apk>`. Run `./scripts/setup-signing.sh` from the repository root
before the first release build. Debug and release use different keys, so uninstall
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

```bash
pnpm --filter @meologue/web build:macos
cd apps/macos
```

| Variant | Command |
| --- | --- |
| Debug | `cargo tauri build --debug` |
| Release | `cargo tauri build` |
| Sandbox debug | `cargo tauri build --debug --config tauri.sandbox.conf.json` |
| Sandbox release | `cargo tauri build --config tauri.sandbox.conf.json` |

Run `./scripts/setup-signing.sh` from the repository root before a release build. It creates a local,
self-signed identity; builds are signed but not notarized, so another Mac requires one explicit
right-click → Open. Personal and Sandbox bundles have separate identifiers and application data.
Both can run and sync at once, each reaching only its own Server.

## Layout

```text
apps/web       React, Vite, and Tailwind UI shared by every platform
apps/android   Capacitor Android shell
apps/macos     Tauri macOS shell
apps/e2e       Playwright tests against the production serving path
packages/core  domain types, local persistence, and Sync engine
server         Rust, Axum, sqlx, and Postgres
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

Tests use the Sandbox Postgres, never the personal database. Stop a running Sandbox Server before a
full end-to-end run if its Reflection and Digest workers cause timeouts. After changing Rust wire
types, regenerate the committed TypeScript contract with:

```bash
pnpm --filter @meologue/core generate:wire-types
```

## Reading further

- [`CONTEXT.md`](CONTEXT.md) defines the domain vocabulary used throughout the codebase.
- [`docs/adr/`](docs/adr/) records architectural decisions and their trade-offs.
- [`server/README.md`](server/README.md) covers Server configuration, endpoints, logs, and tests.

## Not built yet

Automatic conflict copies for concurrent offline edits.
