# meologue

A personal log. Type a thought, press Send, and it shows up on your other devices.

![The meologue web app: a text box reading "What's on your mind?" above a list of recent entries](docs/screenshot-web.png)

Local-first: writes land on the device first and sync in the background, so the app keeps working
when the server doesn't. Self-hosted — a single Rust binary and a Postgres container.

## What it does

- **Send** — type plain text, press Enter or hit Send. That's the entire capture flow; there is no
  title, no folder, no tag to choose first.
- **History** — everything you've written, newest first, on every device.
- **Sync** — an entry written on one device shows up on the others within a few seconds.
- **Offline** — writes land on the device first, so you can capture with the server unreachable and
  it catches up on its own.

Entries are **append-only and immutable** — no edit, no delete. An entry is closer to a thought you
had at a moment than to a document you maintain. That constraint is why there is no conflict
resolution anywhere in the codebase: two devices can never disagree about an entry.

## One app, three platforms

The screenshot above is the web app. These are the same UI, built from the same source, running as
a native macOS window and an installed Android app — not a browser pointed at a website.

| macOS | Android |
| --- | --- |
| <img src="docs/screenshot-macos.png" alt="meologue running as a native macOS window, with the composer above a list of entries" width="440"> | <img src="docs/screenshot-android.png" alt="meologue running as an Android app, showing the same composer and entry list" width="200"> |

## Run it

Needs Node 22+, pnpm, Rust, and Docker.

```bash
pnpm install
docker compose up -d          # Postgres on :5432
```

To stop Postgres again:

```bash
docker compose stop           # container and data both stay
docker compose down           # also removes the container and network
```

`stop` is the one you want day to day — `docker compose start` brings it back. Postgres is
`restart: unless-stopped`, so it returns after a reboot until you stop it explicitly. Neither
command touches your Entries; only `down -v` does, and it discards all of them on this machine.

Then pick a platform. All three talk to the same server, so start it first.

### Web

Two workflows. Both bind `:41207`, so don't run them at the same time.

**Dev (hot reload)** — two long-running processes, each in its own terminal tab:

```bash
cd server && cargo run                # terminal A: API on :41207
pnpm --filter @meologue/web dev       # terminal B: app on :5173, proxying /v1
```

**Production-style** — build the app, then let the server serve both it and the API on one port:

```bash
pnpm --filter @meologue/web build
cd server && cargo run                # app + API together on :41207
```

Sync is opt-in (ADR 0011): open the app, go to Settings, and type a Server URL — even for this
same-origin production-style setup, since an unset Server URL means sync stays off on every
target, with no implicit fallback. For the dev workflow above, point it at the dev origin
(`http://localhost:5173`); for the production-style one, `http://localhost:41207`.

> **Reaching it from another device's browser doesn't work yet.** The server binds `0.0.0.0`, so the
> port is reachable across your LAN or tailnet — but the web app stores Entries in SQLite over OPFS,
> which browsers only allow in a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts).
> Over plain HTTP to anything other than `localhost`, the app shows an explicit "can't store Entries
> here" message instead of a blank page. Use the native apps below for other devices, or put the
> server behind TLS.

### Android

No emulator and no Android Studio — a debug APK built from the command line and installed on a
device over adb. Needs the Android SDK command-line tools and a JDK, with `ANDROID_HOME` and
`JAVA_HOME` set.

Unlike the web build, a packaged app has no same-origin server to talk to, and there's no
build-time address to bake in either (ADR 0011 deleted the last one) — every Device learns its
Server from Settings, typed in after install. Point it at a tailnet address there — that stays
reachable when you change networks, which a LAN address does not. Both native shells allow
plain-HTTP cleartext to any host (ADR 0012), so whatever address you type just works, with no
platform config to touch.

```bash
pnpm --filter @meologue/web build:android
cd apps/web && npx cap sync android    # after changing web code or plugins
cd ../android && ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Android blocks plain HTTP by default, but `network_security_config.xml` permits cleartext to any
host (ADR 0012), so whatever address you type into Settings needs no change there.

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
pnpm --filter @meologue/e2e test:e2e        # boots the real stack, drives a browser

export DATABASE_URL=postgres://meologue:meologue@localhost:5432/meologue
cargo test --manifest-path server/Cargo.toml
```

The server tests provision a database per test, but `sqlx` still needs `DATABASE_URL` set to find
the instance.

The TypeScript wire types are generated from the Rust server, which owns the contract:

```bash
pnpm --filter @meologue/core generate:wire-types
```

The generated output is committed, so a fresh checkout doesn't need a Rust toolchain.

## Reading further

- `CONTEXT.md` — the glossary. Use these words; the code does.
- `docs/adr/` — why things are the way they are, including the three most likely to surprise you:
  there is no authentication (trust is network-level), the sync insert takes an advisory lock on
  purpose, and a client's server address is a build-time default that Settings can override at
  runtime, never synced.

## Not built yet

Offline PWA, editing, conflict copies, export, release signing, app icons beyond
the template defaults, and browser access over plain HTTP from another device.
