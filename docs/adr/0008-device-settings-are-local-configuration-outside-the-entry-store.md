# 0008: Device settings are local configuration, held outside the Entry store

## Status

Accepted. Its resolution-precedence clause (stored value, then the build-time `VITE_SERVER_URL`,
then same-origin) is superseded by [0011](0011-sync-is-opt-in-an-unset-server-url-means-sync-is-off.md) —
empty now means Sync is off, with no fallback behind it. Everything else here — settings as two
plain `localStorage` keys outside the Entry store, read fresh per sync tick — stands.

## Context

Ticket 26 adds a Settings page with two controls: a theme (Light/Dark/System) and a Server URL
that overrides the build-time address ADR 0006 established. Superficially these look unrelated —
one is presentation, the other is networking — but they're the same decision seen twice: each is
a small piece of state that describes how this Device behaves, never something the user Sends,
never something another Device needs to see. Naming that once, rather than deciding storage and
scope separately for each control, is the point of writing one ADR instead of two.

The Entry store (ADR 0001, landed on SQLite by ADR 0007) exists to hold Entries and the Cursor —
domain data that Syncs between Devices and must survive together (ADR 0007's reasoning for why the
Cursor lives beside the Entries it claims to account for). Neither setting is that. A theme choice
and a Server address are per-installation facts: a phone and a laptop can reasonably run different
themes and even point at different servers, and neither fact should travel through Sync or appear
in another Device's History.

## Decision

**Settings are `localStorage`, not the Entry store — two plain string keys, no schema.**
`apps/web/src/lib/settings.ts` reads and writes `meologue.theme` and `meologue.server-url`
directly; there is no JSON blob, no version field, because there's no shared shape between two
independent settings worth coupling with a parse step that can fail on both at once. Every access
is wrapped in try/catch and degrades to a default — `"system"` for an unrecognised or missing
theme, empty string for the Server URL — because `localStorage` throws on write in Safari private
browsing, and this app already models that world for the Entry store
(`entry-store-errors.ts`'s `StorageUnavailableError`). Settings must keep working under the same
conditions Entry storage can fail under, since it's also where a bad Server URL gets fixed.

**The Server URL is read at the point of each sync request, not cached at module load.**
`syncTransport` calls `readServerUrl()` inside the function that runs per tick, falling back to
the build-time `VITE_SERVER_URL` when the stored value is empty. That ordering — stored value,
then build-time constant, then the empty string ADR 0006 already treats as "same-origin, ask
nothing extra of the request" — means saving a new address takes effect on the next sync tick with
no restart, and an empty field reproduces today's behaviour exactly.

**`packages/core` is unchanged.** Both settings are read and written entirely inside `apps/web`;
the sync engine and `EntryStore` interface take a `SyncTransport` and never see where its address
came from. This is what keeps Settings usable when the Entry store fails to open — a bad Server
URL is fixable from a page that never touches SQLite.

## Alternatives considered

- **Store settings as Entries, or in the same SQLite database as Entries and the Cursor.**
  Rejected: ADR 0007 keeps the Cursor beside the Entries specifically because the two must fail
  together — losing one without the other breaks Sync's invariant. Settings have the opposite
  requirement: they must specifically *not* travel with a copy of the Entries (a restore or a
  second Device shouldn't inherit them), and they must keep working precisely when Entry storage
  is the thing that's broken.
- **One JSON blob under a single `localStorage` key, with a schema and a version field.**
  Rejected for two settings this small: a schema earns its cost once there's validation or
  migration logic to share, and a shared blob means a corrupt or unparseable value for one setting
  can take out the other on read. Two independent string keys can't do that to each other.

## Consequences

This reintroduces a browser-storage path shortly after #24 deleted `LocalEntryStore` — a reader
skimming history could mistake this for a regression back toward storing domain data in
`localStorage`. It isn't: `LocalEntryStore` held Entries, domain data that Syncs; `settings.ts`
holds device-local configuration that's deliberately excluded from Sync. The two are opposite
choices about the same storage mechanism, not the same choice repeated.

Falling back to the build-time address when the Server URL field is empty is a waypoint, not the
destination. The setting exists to *override* what a Device was built with, and today "empty"
still means "use the build-time value, or same-origin if that's also empty" — it says nothing
about whether Sync should run at all. The intended end state is Sync being opt-in via this field,
where empty means Sync is off rather than "fall back." That's a separate decision, needing its own
ticket, because it changes what silence in this field means for every existing Device.

The Android and macOS shells still hardcode a cleartext-networking exception for one address
apiece — `apps/android/app/src/main/res/xml/network_security_config.xml`'s `domain-config`, and
`bundle.macOS.exceptionDomain` in `apps/macos/tauri.conf.json`. A user can now type a Server URL
in Settings that the OS refuses to reach because it isn't that hardcoded address, and per this
ticket's explicit non-goal (no sync-status UI), nothing in the app surfaces that failure — it
reaches the console and stops there.
