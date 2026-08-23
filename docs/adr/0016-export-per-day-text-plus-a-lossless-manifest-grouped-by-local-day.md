# 0016: Export is per-day text plus a lossless manifest, grouped by the exporting Device's local day

## Status

Accepted. Extended, not superseded, by
[0030](0030-the-shell-gets-a-root-screen.md): `EntryStore.list()` gained an *optional* keyset page
argument so History could load bounded windows instead of everything at once. Called with no
argument — which is what Export still does — `list()` behaves byte-identically to before this
ADR's own "a backup that quietly omits things is worse than none" rejection of a paginated read.
That rejection is exactly why the argument had to be optional rather than required, and it still
stands; nothing here needed to change for 0030 to ship.

## Context

Ticket 46 gives History an escape hatch to outside the app: a zip a user can read, hand to
another tool, or just keep as a backup. It has to cut this path on one platform first —
serialisation, delivery, UI, tests, docs — so the two follow-up tickets (#47 macOS, #48 Android)
only have to fill in one function each.

Two things about Entries make the format non-trivial. First, `EntryStore.list()` already returns
every Entry (ADR 0001/0007), newest-first, with UTC `createdAt` timestamps — a Device's own clock
never enters storage. Second, `normalizeEntryBody` (`apps/web/src/lib/entry-text.ts`) only trims a
body; it never reflows it, so a body keeps whatever newlines the user typed. That second fact
rules out the obvious plain-text shape of "one Entry per line" — nothing can share a line with a
body that might itself contain several.

## Decision

**One plain-text file per local day, plus a lossless `manifest.json`.** `packages/core`'s
`export/` module (`day-file.ts`, `manifest.ts`, `export-zip.ts`) groups every Entry passed in by
the exporting Device's *local* day — not UTC — and renders `entries/<YYYY-MM-DD>.txt`: a header
naming the date and the UTC offset used, then per Entry a bare `[HH:MM:SS]` line, the body
verbatim on the line(s) after it, and a blank line before the next Entry. Oldest first within a
day — journal reading order, deliberately the reverse of History. Because a body can contain a
line that happens to look exactly like `[11:42:03]`, this file is a *human view*, not a parseable
record.

`manifest.json` is what makes the zip an actual backup rather than just a readable one: for every
Entry it carries `id`, `device_id`, `created_at`, `seq`, `synced_at`, which day file it landed in,
and — the field that makes it lossless — the body again, unmodified. Duplicating bodies costs
almost nothing once deflated, and it means a future import ticket needs no format change to be
exact; it can ignore the day files entirely and read this.

**Days are the exporting Device's local days, computed from an injected offset, not the host's own
timezone.** `Entry.createdAt` is UTC. Grouping by the UTC calendar date would file an Entry
written just after local midnight under the *previous* day — at +05:30, an Entry at 00:30 local
is still 19:00 UTC the day before, so a UTC grouping would silently misplace it, which is exactly
wrong for the one thing a journal's day boundaries are for. `offset.ts`'s `toLocalParts` takes
`offsetMinutes` as a parameter and shifts the UTC instant by hand rather than asking `Date` (or any
host API) what timezone it's running in — this keeps day-grouping a pure function, testable with
any offset regardless of the test runner's own `TZ`, and it's what the caller (`ExportOptions`)
must supply explicitly rather than have this code guess. The offset actually used is recorded in
both the manifest (`utc_offset`) and every day file's header, so a reader — human or a future
importer — never has to guess which convention produced a given file.

**Zipping lives entirely in `packages/core`; only delivery is platform-specific.** `export-zip.ts`
takes `fflate` as `packages/core`'s second-ever runtime dependency (after `drizzle-orm`) and turns
`Entry[]` into zip bytes — pure, no DOM, no Node built-ins, unit-testable the same way the rest of
this package already is. Delivering those bytes to disk is a new build-time seam,
`@/platform/save-file` (mirroring `sqlite-driver`'s seam from ADR 0007/0005): the web
implementation is a `Blob` plus a synthetic `<a download>` click, deliberately not
`showSaveFilePicker` — it's Chromium-only, needs a user-activation gesture and a permission prompt
that are both harder to drive in a test than a plain anchor click, and this app has no need for a
user-chosen path. The Android and macOS implementations throw an explicit "not yet supported on
this platform" error; #48 and #47 fill them in.

**The Export button lives on Settings and always covers every Entry.** Settings is a sibling route
outside `EntryStoreLayout` (ADR 0008/0009), so it has no store handle of its own — it subscribes to
`entryStoreQueryOptions` directly, the same way `SyncLoop` does, and is disabled until that query
resolves. It calls `store.list()` — every Entry, never a search-narrowed subset — because a backup
that silently omits things on account of whatever the user last searched for is worse than no
backup at all.

## Alternatives considered

- **Group by UTC day, and record the offset only for reference.** Rejected — that's the exact bug
  this ADR exists to avoid; recording the "wrong" offset next to entries filed under the wrong day
  doesn't fix the misfiling, it just documents it.
- **Reflow each Entry onto a single line (e.g. escaping or replacing internal newlines) so the day
  file becomes mechanically parseable.** Rejected: it would mean editing body bytes on the way out,
  which contradicts "bodies are never modified" and turns the day file into a second, lossy
  encoding of the Entry rather than a readable rendering of it. The manifest already exists to be
  the parseable copy; asking the human file to also be one is solving the same problem twice, worse
  the second time.
- **Skip the human-readable day files and ship only `manifest.json`.** Rejected: a JSON-only export
  answers "is my data safe" but not "can I actually read this" — the day files are what make the
  zip legible without opening a JSON viewer, which was the point of doing this before the import
  ticket that would make the manifest alone sufficient.
- **`showSaveFilePicker` instead of a Blob download on web.** Rejected: it's Chromium-only (no
  Firefox or Safari support as of this writing), needs a user gesture and grants a filesystem
  permission a plain download doesn't, and neither Playwright nor a unit test can drive its picker
  UI headlessly — a `<a download>` click is observable as an ordinary `download` event instead.
- **Widen `EntryStore` with an export-specific read (e.g. a paginated or streaming `list`).**
  Rejected: `list()` already returns every Entry, and at personal-log scale there's no gain from a
  second read shape — widening the interface would mean touching both implementations and the
  contract suite (`entry-store-contract.ts`) for no gain (see also the note against this in ADR
  0007's Consequences).

## Consequences

Import is explicitly out of scope for this ticket, but the manifest's shape (`schema`,
`exported_at`, `utc_offset`, `device_id`, `entry_count`, and lossless per-Entry fields) is written
as if a future import ticket exists — a schema version rather than an assumed shape, and full
`Entry` fields rather than a display-oriented subset — so that ticket, whenever it lands, has
something to read rather than something to redesign.

The README's "Not built yet" line for export stays in place until #48 (Android) lands, since #47
and #48 are what make Export actually usable on every platform this app ships; removing it now
would be premature for two of the three targets.

A day file and the manifest can, in principle, disagree if a future edit touches one without the
other — nothing enforces that `fileForEntry` (built once, by `groupEntriesIntoDayFiles`) and the
manifest's own `entries` array stay in lockstep beyond both being derived from it in the same
function call (`exportEntriesToZip`). That's a real coupling to keep in mind for whoever next
changes either file's shape, not a defect being carried forward silently — `manifest.test.ts` and
`export-zip.test.ts` both assert the two agree today.
