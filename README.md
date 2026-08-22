# meologue

A personal log. Type a thought, press Send, and it shows up on your other devices.

![The meologue web app: a composer above a list of recent entries, with Composer, History, Reflect and Digest in the navigation rail](docs/screenshot-web.png)

Local-first: writes land on the device first and sync in the background, so the app keeps working
when the server doesn't. Self-hosted — a single Rust binary and a Postgres container.

## What it does

- **Send** — type plain text, press Enter or hit Send. That's the entire capture flow; there is no
  title, no folder, no tag to choose first.
- **History** — everything you've written, newest first, on every device.
- **Sync** — an entry written on one device shows up on the others within a few seconds.
- **Offline** — writes land on the device first, so you can capture with the server unreachable and
  it catches up on its own.
- **Reflect** — ask a question about your History in plain language and get an Answer grounded in
  the Entries that actually back it up.
- **Digest** — prose the Server writes on its own about the last day, week, and month, without
  being asked.

Entries are **append-only and immutable** — no edit, no delete. An entry is closer to a thought you
had at a moment than to a document you maintain. That constraint is why there is no conflict
resolution anywhere in the codebase: two devices can never disagree about an entry.

## One app, three platforms

The screenshot above is the web app. These are the same UI, built from the same source, running as
a native macOS window and an installed Android app — not a browser pointed at a website.

| macOS | Android |
| --- | --- |
| <img src="docs/screenshot-macos.png" alt="meologue running as a native macOS window, with the composer above a list of entries" width="440"> | <img src="docs/screenshot-android.png" alt="meologue running as an Android app, showing the same composer and entry list with a bottom navigation bar" width="150"> |

## Reflect and Digest

Two more ways to read your History, both answered by the Server rather than stored on it.

| Reflect | Digest |
| --- | --- |
| <img src="docs/screenshot-reflect.png" alt="A Reflect Session: the Question 'What did I write about the marathon?' and an Answer grounded in 12 Entries" width="420"> | <img src="docs/screenshot-digest.png" alt="The Digest screen, showing Last day, Last week and Last month cards, each a short paragraph about that stretch of time" width="420"> |

**Reflect** asks a question in plain language and gets an Answer grounded in the Entries that
actually back it up — expand "Grounded in N Entries" to see them. An Answer with no matching
Entries says so plainly rather than inventing one. Conversations are held as Sessions on the
Server (`/reflect/list`), so a Session started on one Device is reachable from any other.

**Digest** is prose the Server writes about a stretch of time without being asked. A background
worker writes one for the most recently completed day, week, and month as each ends; a Digest is
immutable, so an Entry that syncs in late for an already-Digested Period is simply not in it — the
Digest isn't rewritten to catch up.

Both are opt-in, off by default, the same way Sync itself is (ADR 0011): with nothing configured,
`/reflect` and `/digest` still appear in the nav but say the Server doesn't support them yet.
Turning them on needs an OpenAI-compatible endpoint:

```bash
export MEOLOGUE_CHAT_BASE_URL=...   # chat endpoint, needed for both Reflect and Digest
export MEOLOGUE_CHAT_MODEL=...
export MEOLOGUE_CHAT_API_KEY=...    # optional, depends on the endpoint
export MEOLOGUE_EMBED_BASE_URL=...  # embedding endpoint, needed for Reflect only
export MEOLOGUE_EMBED_MODEL=...
export MEOLOGUE_EMBED_API_KEY=...
```

`MEOLOGUE_TZ` (default `UTC`) decides which local day, week, and month an Entry falls into for
Digest purposes — set it to your own timezone (e.g. `Europe/London`), or Digests bucket by UTC days.

See ADR 0021 (the LLM call itself), 0023 (Reflection's fixed three-source fan-out), and 0027 (why
Digests are written ahead of time, forward-only, and never backfilled).

## Run it

Needs Node 22+, pnpm, Rust, and Docker. Then `pnpm install`.

### Two instances, and which one you're starting

meologue runs as **two instances that share this working tree and nothing else** (ADR 0029). One
holds your Entries. The other — the Sandbox — is where testing goes: seeded, driven, wiped and
reseeded freely. It cannot reach your database, your bundle or your installed apps, so your app
keeps working normally while any of that is happening.

**Your app** — Postgres, then build, then serve:

```bash
docker compose up -d                  # Postgres on :5432
pnpm --filter @meologue/web build
cd server && cargo run                # app + API on :41207
```

**The testing app** — one script does all three, then seed it:

```bash
./scripts/sandbox-server.sh           # Postgres on :5442, app + API on :41307
./scripts/seed-sandbox.sh             # ~120 Entries across the last two months
```

`sandbox-server.sh` starts its own Postgres, builds `dist/sandbox` and applies migrations, so it's
the only command needed from cold. Seed *after* it: the Server owns the schema, so a Sandbox on a
brand-new volume has no tables to fill yet.

Run both at once. They share no port, no database, no bundle and no app identifier:

| | Yours | Sandbox |
|---|---|---|
| Postgres | `meologue-postgres` `:5432` | `meologue-postgres-sandbox` `:5442` |
| Server | `:41207` | `:41307` |
| Web bundle | `dist/web` | `dist/sandbox` |
| Android | `com.meologue.app` | `com.meologue.app.sandbox` |
| macOS | `meologue.app` | `meologue-sandbox.app` |

The web split costs no client code at all: two Server ports are two browser origins, and both the
Server URL setting and the SQLite store are keyed to the origin. The native shells install
alongside yours instead of over them, so `adb install -r` and a Tauri build can't replace an app
you're using — `./gradlew assembleSandbox`, and `cargo tauri build --config tauri.sandbox.conf.json`.

**Everything below describes your instance.** The Sandbox is the same app on a different address:
put `http://localhost:41307` into Settings instead.

### Stopping Postgres

```bash
docker compose stop                   # container and data both stay
docker compose down                   # also removes the container and network
docker compose down -v postgres-sandbox   # wipe the Sandbox, keep yours
```

`stop` is the one you want day to day — `docker compose start` brings it back. Postgres is
`restart: unless-stopped`, so it returns after a reboot until you stop it explicitly. Neither
`stop` nor `down` touches your Entries; only `down -v` does. The first two act on your instance
alone: the Sandbox sits behind a `sandbox` profile, so it's only ever touched by a command that
names it.

Which is what the third line does — name the service. **Do not** reach for
`docker compose --profile sandbox down -v` instead: a profile *widens* the set of services a
command applies to rather than narrowing it, so that form deletes your instance's volume too.

Then pick a platform. All three shells sync to whichever Server URL you put in Settings, so start
one of the two servers above first.

### Web

Two workflows. Both bind `:41207`, so don't run them at the same time.

**Dev (hot reload)** — two long-running processes, each in its own terminal tab:

```bash
cd server && cargo run                # terminal A: API on :41207
pnpm --filter @meologue/web dev       # terminal B: app on :5173, proxying /v1
```

To hot-reload against the Sandbox instead, point the proxy at it —
`MEOLOGUE_PROXY_TARGET=http://localhost:41307 pnpm --filter @meologue/web dev` — and leave your own
server alone.

**Production-style** — build the app, then let the server serve both it and the API on one port:

```bash
pnpm --filter @meologue/web build
cd server && cargo run                # app + API together on :41207
```

Sync is opt-in (ADR 0011): open the app, go to Settings, and type a Server URL — even for this
same-origin production-style setup, since an unset Server URL means sync stays off on every
target, with no implicit fallback. `cargo run` prints the Server URL to use
(`http://localhost:41207` by default) — that's correct for the production-style workflow above.
For the dev workflow, use the Vite origin instead (`http://localhost:5173`), since that's where
the app is actually served from and the server has no way to know about that proxy.

**Reaching it from another device's browser** needs HTTPS — the web app stores Entries in SQLite
over OPFS, which browsers only allow in a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts).
Over plain HTTP to anything other than `localhost`, the app shows an explicit "can't store Entries
here" message instead of a blank page. [Tailscale Serve](https://tailscale.com/kb/1312/serve) gets
you a real, auto-renewed certificate for your machine's tailnet name with nothing to install on the
other device:

```bash
tailscale serve --bg http://127.0.0.1:41207
```

Run that once, against the production-style workflow's port — that's the one serving the app and
the API together, which is what a phone or another laptop needs to reach. (The dev workflow's Vite
origin isn't a useful target here: it's meant for hot reload on the machine running it, not for
exposing to other devices.) `--bg` runs it detached — the config lives in `tailscaled`'s own state,
not a process this repo starts or stops, so it's still there after a reboot with no wrapper script
needed. Check what's configured, or remove it, with `tailscale serve status` / `tailscale serve
reset`. Open `https://<your-tailnet-name>.<tailnet>.ts.net/` from any device on your tailnet.

Use the tailnet name, not the tailnet IP: the certificate Tailscale issues is for the name, so an
IP would fail TLS validation even though the traffic reaches the same machine. `tailscale serve
status` prints the full `https://` URL to use.

This is `serve`, not `funnel` — reachable only from devices on your tailnet, never the open
internet. Don't run `tailscale funnel` here; see ADR 0017.

**Installable and offline-capable**, on any HTTPS origin (`localhost` counts too): the browser's
install prompt adds it as its own app, and a service worker keeps it usable — opening the SQLite
store included — with no network at all. Deploying a new build raises an in-app prompt to reload
rather than doing it silently, since a reload could otherwise discard whatever's mid-composition.
Android and macOS never register a service worker; only the web build does.

### Android

No emulator and no Android Studio — a debug APK built from the command line and installed on a
device over adb. Needs the Android SDK command-line tools and a JDK, with `ANDROID_HOME` and
`JAVA_HOME` set.

Unlike the web build, a packaged app has no same-origin server to talk to, and there's no
build-time address to bake in either (ADR 0011 deleted the last one) — every Device learns its
Server from Settings, typed in after install. Point it at a tailnet address there — that stays
reachable when you change networks, which a LAN address does not. Both native shells allow
plain-HTTP cleartext to any host (ADR 0012), so whatever address you type just works, with no
platform config to touch. Once `tailscale serve` is set up (above), the Server URL can just as
well be the `https://` tailnet name instead of a bare `http://` address — neither shell needs the
plain-HTTP exception for that URL specifically, though ADR 0012's cleartext allowance stays in
place regardless, since a LAN address is still a legitimate thing to type there.

```bash
pnpm --filter @meologue/web build:android
cd apps/web && npx cap sync android    # after changing web code or plugins
cd ../android && ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Android blocks plain HTTP by default, but `network_security_config.xml` permits cleartext to any
host (ADR 0012), so whatever address you type into Settings needs no change there.

**Release build.** Needs a signing keystore, which doesn't exist on a fresh checkout — run
`./scripts/setup-signing.sh` once per machine first (ADR 0015). It creates
`~/.meologue/release.keystore` and a gitignored `apps/android/keystore.properties` pointing at
it; re-running the script later is safe, since it refuses to touch a keystore that already
exists. Without that file, `assembleRelease` fails immediately with a message naming the script,
rather than producing an unsigned APK.

```bash
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
pnpm --filter @meologue/web build:android
cd apps/web && npx cap sync android
cd ../android && ./gradlew assembleRelease
```

The output is `app/build/outputs/apk/release/app-release.apk`. Debug and release builds are
signed with different keys, and `adb install -r` refuses to install one over the other — you'll
see `INSTALL_FAILED_UPDATE_INCOMPATIBLE`. `adb uninstall com.meologue.app` first if you're
switching between them on the same device.

### macOS

A Tauri v2 shell. Command Line Tools are enough; full Xcode is not needed. Also needs the Tauri
CLI (`cargo install tauri-cli --version "^2"`).

```bash
pnpm --filter @meologue/web build:macos
cd apps/macos && cargo tauri build --debug
open target/debug/bundle/macos/meologue.app
```

App Transport Security requires an exception for plain-HTTP hosts; `apps/macos/Info.plist` grants
one for any host (ADR 0012), so whatever address you type into Settings needs no change there
either.

**Release build.** Also needs `./scripts/setup-signing.sh` (ADR 0015), which creates a dedicated
keychain holding a self-signed `meologue Dev` certificate — that identity is already named in
`apps/macos/tauri.conf.json`, so signing happens automatically during the build, including the
DMG:

```bash
pnpm --filter @meologue/web build:macos
cd apps/macos && cargo tauri build
open target/release/bundle/macos/meologue.app
```

There's no Apple Developer account behind this cert and never will be (ADR 0015), so the build is
signed but **not notarized**. Opening it on any machine other than the one that built it — or
even the same machine after `setup-signing.sh` has regenerated the keychain — trips Gatekeeper's
"unidentified developer" block. Right-click the app (or the mounted DMG's copy) and choose Open
once; that exception then persists for that app on that machine.

## Layout

```
apps/web       React 19, Vite, Tailwind v4, shadcn/ui — the UI for all three platforms
apps/android   Capacitor's generated Android project (committed as source)
apps/macos     Tauri v2 crate for the macOS shell (committed as source)
apps/e2e       Playwright, against the production serving path
packages/core  sync engine and domain types — no React, no DOM
server         Rust, Axum, sqlx, Postgres
```

There is **one** Vite application, not one per platform (ADR 0005). Where a platform genuinely
differs, the difference sits behind a build-time seam in `apps/web/src/platform/`, selected by
`--mode`. `packages/core` is platform-agnostic and shared verbatim: anything environment-specific —
timers, focus events, `fetch` — is injected into it.

Both native projects are committed as source; only their build output is ignored. Tauri has no
regeneration story, so a checkout without `apps/macos` couldn't build the app at all.

## How sync works

One endpoint, `POST /v1/sync`, doing both directions in a single round trip: the client sends
anything unsynced along with its cursor, and gets back everything recorded after it. Clients poll
every few seconds while visible, and on focus and reconnect. No websockets.

Because entries are append-only and immutable, there are no conflicts to resolve. Ordering for the
cursor is a server-assigned sequence; display order is the client's timestamp, because when you
wrote a thought is what you'll care about later.

Android is the one platform that doesn't use browser focus events — backgrounding a WebView doesn't
reliably flip `document.visibilityState`, so it listens to Capacitor's app-lifecycle events instead.

## Checks

```bash
pnpm test                                   # unit tests (core + web)
pnpm lint
./scripts/e2e.sh                            # boots the real stack, drives a browser

export DATABASE_URL=postgres://meologue:meologue@localhost:5442/meologue
cargo test --manifest-path server/Cargo.toml
```

The server tests provision a database per test, but `sqlx` still needs `DATABASE_URL` set to find
the instance. Point it at `:5442` — the Sandbox, below — rather than your own Postgres: an
interrupted run leaves its throwaway `_sqlx_test_*` databases behind, and they are better left
somewhere you don't keep Entries.

Run the e2e suite through `scripts/e2e.sh` rather than `test:e2e` directly; it recreates the two
databases the suite's two servers need before handing over. Your own server can stay up during a
run — but stop the Sandbox one, whose embedding and Digest workers load the machine enough to
time out the slowest specs.

All of it runs against the Sandbox, never your instance — see "Two instances" above.

The TypeScript wire types are generated from the Rust server, which owns the contract:

```bash
pnpm --filter @meologue/core generate:wire-types
```

The generated output is committed, so a fresh checkout doesn't need a Rust toolchain.

## Reading further

- `CONTEXT.md` — the glossary. Use these words; the code does.
- `docs/adr/` — why things are the way they are, including a few most likely to surprise you: there
  is no authentication (trust is network-level), the sync insert takes an advisory lock on purpose,
  a client's Server URL lives only in Settings — no build-time default, never synced — and Reflect
  and Digest are both off until an LLM endpoint is configured (above).

## Not built yet

Editing and conflict copies.
