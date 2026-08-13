# 0007: SQLite EntryStore — driver as a build-time seam, Cursor stored beside Entries

## Status

Accepted

## Context

ADR 0001 put persistence behind an injected `EntryStore` interface so the rest of the codebase
never depends on a storage engine directly. This ticket lands the first real implementation of
that interface — SQLite, via drizzle — while the app keeps shipping `LocalEntryStore`
(`localStorage`) until a later ticket switches it over.

drizzle's `sqlite-proxy` driver lets `packages/core` depend on SQL and a schema without
depending on *how* a query actually runs — every call goes through one callback,
`(sql, params, method) => Promise<{ rows }>`. That callback is the only piece that has to differ
per platform: a Node driver here (backing the contract suite), and later a real driver per
target (Android's WebView bridge, macOS's WKWebView bridge). Everything else — the schema, the
migration SQL, the migration runner, the `EntryStore` implementation — is platform-free and lives
in `packages/core` once, unconditionally compiled into every build.

That mirrors ADR 0005's shape even though it isn't literally that seam: ADR 0005 resolves a file
per platform *at build time* via a Vite alias, because the difference it isolates
(`wake-signals`) is a handful of free functions with no state and no construction step. A
`SqliteDriver` is a stateful object wired up once, early, and threaded through `open()` — that's
a constructor argument, not an import alias. The two are the same idea (isolate what a platform
does differently behind a narrow interface, keep the rest shared) applied at the shape the seam
actually has: a value passed in, not a module resolved.

Two further problems are specific to embedding SQLite behind a proxy callback rather than a real
driver:

- drizzle ships a migrator for `sqlite-proxy`, but it reads migration files off disk via
  `node:fs` to build its journal. `node:fs` doesn't exist in a WebView, so that migrator can
  never run on Android or macOS. The runner has to be hand-written regardless of how thin that
  makes it feel today.
- The proxy callback's `rows` are positional — `unknown[]`, ordered to match whatever columns
  the query asked for — because drizzle already knows that order internally and never re-derives
  it from column names. A driver's raw result (node:sqlite's, and presumably a native mobile
  bridge's) is column-named objects. Something has to turn one into the other, and getting it
  wrong doesn't throw: drizzle assigns whatever landed in a given position to the field it
  expected there, so a mis-ordered row produces a body sitting where a timestamp belongs.

## Decision

**The `SqliteDriver` interface is the seam; drivers are constructed once and passed to `open()`.**
`packages/core/src/sqlite/driver.ts` declares it, shaped to match drizzle's proxy callback
exactly. `node-driver.ts` implements it against `node:sqlite` (built into Node, so the test
driver needs no native compilation step) and is used *only* by tests — it is what makes the
shared contract suite (`test-support/entry-store-contract.ts`) an honest verification of the
SQLite store rather than a promise that it will behave once a real driver exists. A future
Android or macOS ticket adds its own driver beside its own app; none of `packages/core` changes
to accommodate it.

**Positional row-mapping happens in exactly one place.** `row-mapping.ts` exports
`toPositionalRow`, which every driver implementation calls on its own raw rows before handing
them to drizzle. It asserts the row is a plain column-named object (not `null`, not an array)
before trusting `Object.values()` to preserve column order — cheap insurance against a future
driver's result shape being subtly different, since the failure mode this guards is silent.
Centralising it means a second, differently-wrong reimplementation per platform can't exist.

**The Cursor and this Device's id live in the same SQLite database as the Entries they concern**,
in a small `kv` table (`schema.ts`), not in a separate store (e.g. `localStorage` or platform
preferences) alongside it. The Cursor (ADR 0002) is a claim: "every Entry up to this sequence is
already here." That claim is only true as long as the Entries backing it are still there. If the
Cursor lived somewhere that survives independently of the Entries — a separate database, a
different storage mechanism entirely — a Device could lose its SQLite file (reinstall, corrupted
file, cleared app data) while its Cursor persisted, and Sync would believe everything up to that
point had already arrived. It would ask only for what comes after, and silently, permanently
never re-fetch what it lost. Losing the Cursor *with* the Entries is self-healing — Sync just
asks for everything again — so the two must fail together, which means they must live together.

**No SQL transaction wraps any of this, and the reason is recorded rather than left implicit:**

- Every statement in the generated migration is `CREATE ... IF NOT EXISTS`, so re-running a
  migration that was interrupted partway through (schema created, ledger row not yet written) is
  harmless — the next run just re-issues DDL that's already true and then records it.
- `upsert()` is one `INSERT ... ON CONFLICT DO UPDATE` statement covering the whole batch
  (`sqlite-entry-store.ts`), not a loop of single-row writes, so there's no multi-statement
  window for a batch to partially apply.
- The sync engine (`sync-engine.ts`) already writes Entries via `upsert()` *before* calling
  `setCursor()`. If the process dies between those two calls, the Cursor is behind what's
  actually stored, not ahead of it — the next sync re-fetches a page it already has (redundant,
  not lossy) rather than skipping one it doesn't (lossy).

This stops holding the moment any of those three changes: a migration with an `ALTER TABLE` or a
data backfill (no longer safely re-runnable), a multi-statement write that isn't a single
upsert, or a write ordering where the Cursor could advance ahead of the Entries it claims to
account for. Whoever changes one of those adds a transaction; this paragraph is what they're
overriding.

**`drizzle-kit push` must never be run against this project.** `push` diffs a schema against a
live database and applies the difference directly — it doesn't consult or write our migration
ledger (`migrator.ts`) at all. Running it once would leave a database schema our ledger doesn't
know how it got there, silently out of step with what `MIGRATIONS` in `migrations/index.ts` says
should have been applied. `drizzle.config.ts` documents this; `drizzle-kit generate` is the only
drizzle-kit command this project uses.

## Alternatives considered

- **Use drizzle's own `sqlite-proxy` migrator.** Rejected outright — it hard-imports `node:fs`,
  which makes it a Node-only migrator for a store that has to run inside a WebView.
- **Store the Cursor and Device id in each platform's native local storage (`localStorage` on
  web, `SharedPreferences`/`UserDefaults` natively) instead of in SQLite.** Rejected: that's
  exactly the split failure mode described above — a mechanism that can survive independently of
  the Entries it's supposed to account for.
- **Wrap every write in a transaction preemptively, since SQLite makes it cheap.** Rejected: a
  transaction that isn't protecting against a real failure mode is undocumented insurance nobody
  can evaluate later — the point of this ADR is to make the *absence* legible and falsifiable,
  not to add ceremony that looks safer without anyone having reasoned about what it's for.
- **Add `updated_at`, `rev`, and `deleted_at` columns now, dormant, so a future editing feature
  needs no migration.** Rejected: editing only means anything once it travels between Devices,
  and the server has no such columns or wire fields either — editing requires a server migration
  and a wire contract change regardless of what the SQLite schema already has. Dormant columns
  would commit us to semantics nobody has designed yet, for a migration we can't actually skip.

## Consequences

Adding a platform's real driver later means writing one file implementing `SqliteDriver` against
that platform's native SQLite bridge and calling `toPositionalRow` on its raw rows — nothing
under `packages/core/src/sqlite/` besides that file changes. Adding a second migration means
generating it with `drizzle-kit generate`, hand-editing its DDL to be idempotent (drizzle-kit
does not emit `IF NOT EXISTS` on its own), and appending it to `MIGRATIONS`; if that migration
needs an `ALTER TABLE` or a backfill, the no-transaction reasoning above no longer holds and
`migrator.ts` needs a transaction around each migration's statements. `apps/web` does not import
any of this yet — it still constructs `LocalEntryStore` directly — so `SqliteEntryStore` is
exercised only by the contract suite until the ticket that wires it into the app.
